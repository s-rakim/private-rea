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

  # One dev-mode server for the whole run.
  def server
    @server ||= TestServer.new.tap(&:start)
  end

  def unique(name)
    "#{name}-#{Tailchat::Crypto.b64u(Tailchat::Crypto.random_bytes(4)).downcase.tr('_', 'x')}"[0, 32]
  end

  def scratch
    @scratch ||= Dir.mktmpdir('tailchat-ruby-test-')
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

  # Loads an example script (they only run their bot when executed directly).
  def load_example(name)
    @loaded ||= {}
    @loaded[name] ||= load(File.join(EXAMPLES, name)) || true
  end

  class TestServer
    attr_reader :base, :log_path

    def start
      TestSupport.ensure_node_modules
      @data = Dir.mktmpdir('tailchat-server-')
      @log_path = File.join(@data, 'server.log')
      port = TestSupport.free_port
      env = {
        'TAILCHAT_AUTH' => 'dev', 'TAILCHAT_HOST' => '127.0.0.1', 'TAILCHAT_PORT' => port.to_s,
        'TAILCHAT_DATA' => File.join(@data, 'data'),
      }
      @pid = Process.spawn(env, *TestSupport.server_command, chdir: TestSupport::TAILCHAT_ROOT,
                                                               out: @log_path, err: @log_path, pgroup: true)
      @base = "http://127.0.0.1:#{port}"
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
  TestSupport.instance_variable_get(:@server)&.stop
  scratch = TestSupport.instance_variable_get(:@scratch)
  FileUtils.rm_rf(scratch) if scratch
end
