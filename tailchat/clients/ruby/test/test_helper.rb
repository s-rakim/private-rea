# frozen_string_literal: true

$LOAD_PATH.unshift(File.expand_path('../lib', __dir__))
require 'tailchat'
require 'minitest/autorun'
require 'open3'
require 'socket'
require 'stringio'
require 'tmpdir'

module TestSupport
  TAILCHAT_ROOT = File.expand_path('../../..', __dir__) # tailchat/
  RUBY_ROOT = File.expand_path('..', __dir__)
  EXAMPLES = File.join(RUBY_ROOT, 'examples')
  QUIET = Logger.new(File::NULL)

  module_function

  # VERBOSE=1 shows the bots' logs.
  def logger
    ENV['VERBOSE'].to_s.empty? ? QUIET : Logger.new($stderr, progname: 'bot')
  end

  # How to start the server under test, in order of preference:
  #   1. TAILCHAT_SERVER_CMD (a shell command, run from tailchat/)
  #   2. the Python port, if tailchat/tailchat_server/__main__.py exists
  #   3. the Node server
  def server_command
    custom = ENV['TAILCHAT_SERVER_CMD'].to_s
    return ['sh', '-c', custom] unless custom.empty?
    return %w[python3 -m tailchat_server] if File.exist?(File.join(TAILCHAT_ROOT, 'tailchat_server', '__main__.py'))
    %w[node --no-warnings=ExperimentalWarning server/index.js]
  end

  # node_modules is needed by the Node server and by test/js/peer.mjs (ws).
  def ensure_node_modules
    return if File.exist?(File.join(TAILCHAT_ROOT, 'node_modules', 'ws', 'package.json'))
    out, status = Open3.capture2e('npm', 'install', '--no-audit', '--no-fund', chdir: TAILCHAT_ROOT)
    raise "npm install failed:\n#{out}" unless status.success?
  end

  def free_port
    server = TCPServer.new('127.0.0.1', 0)
    server.addr[1]
  ensure
    server&.close
  end

  # One dev-mode server and one scratch directory for the whole run (module
  # state: module_function copies would give each test instance its own).
  SHARED = { lock: Mutex.new }

  def server
    SHARED[:lock].synchronize { SHARED[:server] ||= TestServer.new.tap(&:start) }
  end

  def scratch
    SHARED[:lock].synchronize { SHARED[:scratch] ||= Dir.mktmpdir('tailchat-rb-test-') }
  end

  def unique(name)
    "#{name}-#{Tailchat::Crypto.b64u(Tailchat::Crypto.random_bytes(4)).downcase.tr('_', 'x')}"[0, 32]
  end

  def client(user, **options)
    Tailchat::Client.new(server: server.base, dev_user: user, logger: QUIET,
                         state: File.join(scratch, "#{user}-#{rand(1 << 30)}.json"), **options)
  end

  def wait_until(timeout = 8, interval = 0.05)
    deadline = Time.now + timeout
    loop do
      result = yield
      return result if result
      raise Minitest::Assertion, 'timed out waiting for condition' if Time.now > deadline
      sleep interval
    end
  end

  # The first event from `queue` matching the block.
  def next_event(queue, timeout = 8)
    deadline = Time.now + timeout
    loop do
      left = deadline - Time.now
      event = left.positive? ? queue.pop(timeout: left) : nil
      raise Minitest::Assertion, 'timed out waiting for an event' unless event
      return event if yield(event)
    end
  end

  # Loads an example script (they only run their bot when executed directly).
  def load_example(name)
    require File.join(EXAMPLES, name)
  end

  class TestServer
    attr_reader :base, :log_path, :ca_path

    # tls: serve HTTPS with a throwaway CA (TAILCHAT_TLS_CERT / TAILCHAT_TLS_KEY).
    def initialize(tls: false)
      @tls = tls
    end

    def start
      TestSupport.ensure_node_modules
      @data = Dir.mktmpdir('tailchat-rb-server-')
      @log_path = File.join(@data, 'server.log')
      port = TestSupport.free_port
      env = {
        'TAILCHAT_AUTH' => 'dev', 'TAILCHAT_HOST' => '127.0.0.1', 'TAILCHAT_PORT' => port.to_s,
        'TAILCHAT_DATA' => File.join(@data, 'data'),
      }
      env.merge!(make_certificates) if @tls
      $stderr.puts "# Tailchat server under test: #{TestSupport.server_command.join(' ')} (port #{port})"
      @pid = Process.spawn(env, *TestSupport.server_command, chdir: TestSupport::TAILCHAT_ROOT,
                                                               out: @log_path, err: @log_path, pgroup: true)
      @base = "#{@tls ? 'https' : 'http'}://127.0.0.1:#{port}"
      wait_for_port(port)
      at_exit { stop }
    end

    def stop
      return unless @pid
      Process.kill('TERM', -Process.getpgid(@pid)) rescue nil # rubocop:disable Style/RescueModifier
      deadline = Time.now + 5
      sleep 0.05 while Time.now < deadline && !Process.wait(@pid, Process::WNOHANG)
      Process.kill('KILL', -@pid) rescue nil # rubocop:disable Style/RescueModifier
      Process.wait(@pid) rescue nil # rubocop:disable Style/RescueModifier
      @pid = nil
      FileUtils.rm_rf(@data)
    end

    private

    # A CA and a certificate for 127.0.0.1 / localhost signed by it.
    def make_certificates
      ca_key = OpenSSL::PKey::EC.generate('prime256v1')
      ca = certificate('/CN=Tailchat test CA', ca_key, ca_key.public_to_der) do |ext|
        [ext.create_extension('basicConstraints', 'CA:TRUE', true), ext.create_extension('keyUsage', 'keyCertSign,cRLSign', true)]
      end
      key = OpenSSL::PKey::EC.generate('prime256v1')
      leaf = certificate('/CN=127.0.0.1', ca_key, key.public_to_der, issuer: ca) do |ext|
        [ext.create_extension('basicConstraints', 'CA:FALSE', true),
         ext.create_extension('subjectAltName', 'IP:127.0.0.1,DNS:localhost'),
         ext.create_extension('extendedKeyUsage', 'serverAuth')]
      end
      @ca_path = File.join(@data, 'ca.pem')
      File.write(@ca_path, ca.to_pem)
      File.write(File.join(@data, 'cert.pem'), leaf.to_pem)
      File.write(File.join(@data, 'key.pem'), key.private_to_pem, perm: 0o600)
      { 'TAILCHAT_TLS_CERT' => File.join(@data, 'cert.pem'), 'TAILCHAT_TLS_KEY' => File.join(@data, 'key.pem') }
    end

    def certificate(subject, signing_key, public_der, issuer: nil)
      cert = OpenSSL::X509::Certificate.new
      cert.version = 2
      cert.serial = rand(1 << 60)
      cert.subject = OpenSSL::X509::Name.parse(subject)
      cert.issuer = issuer ? issuer.subject : cert.subject
      cert.public_key = OpenSSL::PKey.read(public_der)
      cert.not_before = Time.now - 60
      cert.not_after = Time.now + 3600
      ext = OpenSSL::X509::ExtensionFactory.new
      ext.subject_certificate = cert
      ext.issuer_certificate = issuer || cert
      yield(ext).each { |e| cert.add_extension(e) }
      cert.sign(signing_key, OpenSSL::Digest.new('SHA256'))
      cert
    end

    def wait_for_port(port)
      deadline = Time.now + 30
      loop do
        Socket.tcp('127.0.0.1', port, connect_timeout: 0.5).close
        return
      rescue SystemCallError
        if Process.wait(@pid, Process::WNOHANG)
          @pid = nil
          raise "server exited during startup:\n#{File.read(@log_path)}"
        end
        raise "server did not listen on #{port}:\n#{File.read(@log_path)}" if Time.now > deadline
        sleep 0.1
      end
    end
  end

  # A device driven through test/js/peer.mjs, i.e. public/crypto.js.
  class JsPeer
    attr_reader :user_id, :device_id

    def initialize(base, user)
      script = File.join(__dir__, 'js', 'peer.mjs')
      @stdin, @stdout, @wait = Open3.popen2('node', script, base)
      reg = call('register', user: user)
      @user_id = reg['userId']
      @device_id = reg['deviceId']
    end

    def call(cmd, **args)
      @stdin.puts(JSON.generate(args.merge(cmd: cmd)))
      @stdin.flush
      line = @stdout.gets or raise "node peer exited (#{@wait.value})"
      reply = JSON.parse(line.force_encoding(Encoding::UTF_8))
      raise "node peer #{cmd} failed: #{reply['error']}" unless reply['ok']
      reply
    end

    def close
      @stdin.close unless @stdin.closed?
      @wait.join(5)
    end
  end
end

Minitest.after_run do
  TestSupport::SHARED[:server]&.stop
  FileUtils.rm_rf(TestSupport::SHARED[:scratch]) if TestSupport::SHARED[:scratch]
end
