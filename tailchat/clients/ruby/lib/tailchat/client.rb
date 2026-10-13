# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'logger'
require 'net/http'
require 'pathname'
require 'socket'
require 'tempfile'
require 'time'
require 'uri'

module Tailchat
  # A non-2xx answer from the server.
  class HTTPError < Error
    attr_reader :status, :method, :path

    def initialize(status, method, path, message)
      @status = status
      @method = method
      @path = path
      super("#{method} #{path} -> #{status} #{message}")
    end
  end

  # One Tailchat device: its key pair and bearer token (kept in a 0600 state
  # file), the REST API, end-to-end encryption and the realtime WebSocket.
  #
  #   client = Tailchat::Client.new(server: 'https://chat.example.ts.net', state: '~/.tailchat/bot.json')
  #   chat = client.direct_chat('alice@example.com')
  #   client.send_text(chat['id'], 'hello')
  #   client.listen { |event| p event }
  class Client
    DEV_USER = /\A[a-z0-9._-]{1,32}\z/
    STATE_VERSION = 1
    RETRYABLE = [EOFError, IOError, Errno::ECONNRESET, Errno::EPIPE, Errno::ECONNABORTED, OpenSSL::SSL::SSLError].freeze

    attr_reader :server, :state_path, :dev_user, :device_name, :logger

    # server:      https://<machine>.<tailnet>.ts.net (or http://127.0.0.1:8443 in dev mode)
    # state:       where the device key and token live (created 0600)
    # device_name: shown in the user's "Linked devices"
    # dev_user:    dev mode only: sends X-Dev-User so the server treats us as <dev_user>@dev
    # ca_file:     a PEM file of CAs to trust instead of the system store (ts.net
    #              certificates are publicly trusted, so you rarely need it)
    def initialize(server: ENV['TAILCHAT_SERVER'], state: nil, device_name: nil, dev_user: nil, logger: nil,
                   ca_file: nil, open_timeout: 10, read_timeout: 60)
      raise ArgumentError, 'server: is required (or set TAILCHAT_SERVER)' if server.to_s.empty?
      @server = server.to_s.chomp('/')
      @uri = URI(@server)
      raise ArgumentError, "server must be an http(s) URL, got #{server}" unless %w[http https].include?(@uri.scheme) && @uri.host
      if dev_user
        dev_user = dev_user.to_s
        raise ArgumentError, 'dev_user must match [a-z0-9._-]{1,32}' unless dev_user.match?(DEV_USER)
      end
      @dev_user = dev_user
      @state_path = File.expand_path(state || File.join(Dir.home, '.tailchat', "#{dev_user || 'device'}.json"))
      @device_name = device_name || "Tailchat Ruby on #{Socket.gethostname}"
      @logger = logger || Logger.new($stderr, progname: 'tailchat', level: Logger::INFO)
      @cert_store = ca_file && OpenSSL::X509::Store.new.tap { |store| store.add_file(File.expand_path(ca_file)) }
      @open_timeout = open_timeout
      @read_timeout = read_timeout
      @lock = Mutex.new
      @http_lock = Mutex.new
      @state = load_state
      @keyring = nil
      @socket = nil
      @stopping = false
    end

    # ---------- device & identity ----------

    def registered?
      !@state.nil?
    end

    # Registers this device (once): a fresh P-256 key pair, saved with the
    # token in the state file. Later runs reuse it.
    def register!
      @lock.synchronize do
        return @state if @state
        key = Crypto.generate_key
        res = request(:post, '/api/devices', json: { name: @device_name, publicKey: Crypto.public_jwk(key) }, auth: false)
        state = {
          'version' => STATE_VERSION,
          'server' => @server,
          'userId' => res['device']['userId'],
          'deviceId' => res['device']['id'],
          'deviceName' => @device_name,
          'token' => res['token'],
          'privateKey' => key.private_to_pem,
          'createdAt' => Time.now.utc.iso8601,
        }
        write_state(state)
        logger.info("registered device #{state['deviceId']} for #{state['userId']} (state in #{@state_path})")
        @state = state
      end
    end

    def device_id = register!['deviceId']
    def user_id = register!['userId']

    def keyring
      @keyring ||= begin
        state = register!
        KeyRing.new(
          device_id: state['deviceId'],
          user_id: state['userId'],
          private_key: OpenSSL::PKey.read(state['privateKey']),
          fetch_devices: ->(ids) { get("/api/keys?#{URI.encode_www_form(ids: ids.join(','))}")['devices'] },
        )
      end
    end

    # ---------- REST ----------

    def me = get('/api/me')
    def users = get('/api/users')['users']
    def devices = get('/api/devices')['devices']
    def user_devices(user_id) = get("/api/users/#{seg(user_id)}/devices")['devices']
    def chats = get('/api/chats')['chats']
    def chat(chat_id) = get("/api/chats/#{seg(chat_id)}")['chat']
    def chat_devices(chat_id) = get("/api/chats/#{seg(chat_id)}/devices")['devices']

    # The one direct chat with `user_id` (created on first use). Your own id
    # gives your "message yourself" chat.
    def direct_chat(user_id)
      post('/api/chats/direct', { userId: user_id })['chat']
    end

    def create_group(name, members, description: nil)
      post('/api/chats/group', { name: name, members: members, description: description }.compact)['chat']
    end

    # One page of history, decrypted: an Array of Message (oldest first).
    def history(chat_id, before: nil, after: nil, limit: nil)
      raw_messages(chat_id, before: before, after: after, limit: limit)['messages'].map { |m| open_message(m) }
    end

    # One message by id, decrypted.
    def message(message_id)
      open_message(get("/api/messages/#{seg(message_id)}")['message'])
    end

    # {"messages" => [...], "hasMore" => bool} straight from the server.
    def raw_messages(chat_id, before: nil, after: nil, limit: nil)
      query = { before: before, after: after, limit: limit }.compact
      get("/api/chats/#{seg(chat_id)}/messages#{query.empty? ? '' : "?#{URI.encode_www_form(query)}"}")
    end

    # Decrypts a message object from the API or a WebSocket event. Never
    # raises for crypto problems: check Message#error.
    def open_message(raw)
      return Message.new(raw, client: self, content: system_content(raw)) if raw['kind'] == 'system'
      return Message.new(raw, client: self, error: Error.new('no payload (deleted, or a view-once already opened)')) unless raw['payload']
      # The envelope proves which device sealed it; KeyRing#open checks that
      # device belongs to the user the server says sent it.
      content = keyring.open(raw['payload'], Crypto.chat_aad(raw['chatId'], raw['id']), sender_id: raw['senderId'])
      Message.new(raw, client: self, content: content)
    rescue CryptoError => e
      Message.new(raw, client: self, error: e)
    end

    # Encrypts `content` (a §4 Hash) for every device in the chat and posts it.
    def send_content(chat_id, content, files: [], view_once: false)
      id = Crypto.new_message_id
      payload = keyring.seal(content, Crypto.chat_aad(chat_id, id), chat_devices(chat_id))
      body = { id: id, payload: payload }
      body[:files] = files unless files.empty?
      body[:viewOnce] = true if view_once
      # Safe to retry: the server de-duplicates by message id.
      raw = post("/api/chats/#{seg(chat_id)}/messages", body, retryable: true)['message']
      Message.new(raw, client: self, content: JSON.parse(JSON.generate(content)))
    end

    # extra: mentions:, forwarded:, linkPreview: … are copied into the content.
    def send_text(chat_id, text, reply_to: nil, **extra)
      content = { 'type' => 'text', 'text' => text.to_s }
      content['replyTo'] = quote(reply_to) if reply_to
      extra.each { |k, v| content[k.to_s] = v }
      send_content(chat_id, content)
    end

    # source: a path or an IO. Encrypts in 1 MiB chunks, uploads and sends a
    # `media` message. kind defaults from the MIME type.
    def send_file(chat_id, source, name: nil, mime: nil, kind: nil, caption: nil, reply_to: nil, view_once: false, **extra)
      file = upload_file(source, name: name, mime: mime)
      content = { 'type' => 'media', 'kind' => kind || media_kind(file['mime']), 'file' => file }
      content['caption'] = caption if caption
      content['replyTo'] = quote(reply_to) if reply_to
      extra.each { |k, v| content[k.to_s] = v }
      send_content(chat_id, content, files: [file['id']], view_once: view_once)
    end

    # Encrypts and uploads a file; returns the content's `file` object.
    def upload_file(source, name: nil, mime: nil)
      io, size, close = open_source(source)
      name ||= source.is_a?(String) || source.is_a?(Pathname) ? File.basename(source.to_s) : 'file'
      Tempfile.create(['tailchat-upload', '.bin']) do |tmp|
        tmp.binmode
        file = Crypto.encrypt_stream(io, tmp, size)
        tmp.flush
        tmp.rewind
        up = upload_blob(tmp, tmp.size)
        file.merge('id' => up['id'], 'name' => name, 'mime' => mime || 'application/octet-stream')
      end
    ensure
      io.close if close && io
    end

    # Uploads already-encrypted bytes (a String or an IO with its length).
    def upload_blob(blob, length = blob.bytesize)
      req = Net::HTTP::Post.new('/api/files', headers.merge('Content-Type' => 'application/octet-stream'))
      req.content_length = length
      if blob.is_a?(String) then req.body = blob
      else req.body_stream = blob
      end
      with_fresh_http(read_timeout: 600) { |http| parse_response(http.request(req), 'POST', '/api/files') }
    end

    # Downloads a file object's blob into `io`, decrypting as it streams.
    # Raises CryptoError (after writing some plaintext) if anything is off,
    # so write to a temporary file and keep it only on success.
    def download_file(file, io)
      path = "/api/files/#{seg(file['id'])}"
      decryptor = Crypto::FileDecryptor.new(file, io)
      with_fresh_http(read_timeout: 600) do |http|
        http.request(Net::HTTP::Get.new(path, headers)) do |res|
          unless res.is_a?(Net::HTTPSuccess)
            parse_response(res, 'GET', path)
          end
          res.read_body { |chunk| decryptor << chunk }
        end
      end
      decryptor.finish
    end

    def read_file(file)
      out = StringIO.new(''.b)
      download_file(file, out)
      out.string
    end

    def receipts(chat_id, delivered: nil, read: nil)
      post("/api/chats/#{seg(chat_id)}/receipts", { delivered: delivered, read: read }.compact, retryable: true)
    end

    def react(message_id, emoji)
      post("/api/messages/#{seg(message_id)}/react", { emoji: emoji })
    end

    # Replaces a message's content (within the server's edit window).
    def edit(message, content)
      content = { 'type' => 'text', 'text' => content } if content.is_a?(String)
      payload = keyring.seal(content, Crypto.chat_aad(message.chat_id, message.id), chat_devices(message.chat_id))
      open_message(request(:put, "/api/messages/#{seg(message.id)}", json: { payload: payload })['message'])
    end

    def delete_message(message_id, for_everyone: false)
      request(:delete, "/api/messages/#{seg(message_id)}#{for_everyone ? '?for=everyone' : ''}")
    end

    # The 60-digit code to compare in person (§3) for a user's devices.
    def security_code(user_id)
      Crypto.security_code(user_devices(user_id))
    end

    def get(path) = request(:get, path)
    def post(path, body = {}, retryable: false) = request(:post, path, json: body, retryable: retryable)
    def patch(path, body) = request(:patch, path, json: body)

    def request(method, path, json: nil, auth: true, retryable: false)
      register! if auth
      klass = Net::HTTP.const_get(method.to_s.capitalize)
      req = klass.new(path, headers(auth: auth))
      if json
        req['Content-Type'] = 'application/json'
        req.body = JSON.generate(json)
      end
      attempts = (retryable || method != :post) ? 2 : 1
      begin
        res = @http_lock.synchronize { persistent_http.request(req) }
      rescue *RETRYABLE
        @http_lock.synchronize { reset_http }
        attempts -= 1
        retry if attempts.positive?
        raise
      end
      parse_response(res, method.to_s.upcase, path)
    end

    # ---------- realtime ----------

    # Opens the WebSocket and yields every server event (a Hash) until #stop.
    # Reconnects with backoff; the first event after each (re)connect is
    # {"type"=>"ready"}, a good moment to catch up on missed messages.
    # #stop is final for this client.
    def listen(reconnect: true)
      backoff = 1
      until @stopping
        begin
          ws = open_socket
          backoff = 1
          yield({ 'type' => 'ready', 'deviceId' => device_id })
          pump(ws) { |event| yield event }
        rescue WebSocket::Error, SystemCallError, IOError, OpenSSL::SSL::SSLError, SocketError => e
          break if @stopping
          if e.is_a?(WebSocket::Closed) && e.code == 4003
            raise Error, "the server refused this device (#{e.reason}); was it logged out?"
          end
          raise unless reconnect
          logger.warn("realtime connection lost (#{e.message}), reconnecting in #{backoff}s")
        ensure
          @socket = nil
          ws&.shutdown
        end
        break if @stopping || !reconnect
        sleep_unless_stopped(backoff)
        backoff = [backoff * 2, 30].min
      end
    end

    def stop
      @stopping = true
      @socket&.shutdown
    end

    def listening?
      !@socket.nil?
    end

    # Typing indicator (needs a live #listen connection).
    def typing(chat_id, on: true, kind: 'typing')
      @socket&.send_text(JSON.generate({ type: 'typing', chatId: chat_id, on: on, kind: kind }))
    end

    def ws_url
      "#{@uri.scheme == 'https' ? 'wss' : 'ws'}://#{@uri.host}:#{@uri.port}/ws"
    end

    private

    def open_socket
      extra = @dev_user ? { 'X-Dev-User' => @dev_user } : {}
      ws = WebSocket.connect(ws_url, headers: extra, cert_store: @cert_store, timeout: @open_timeout)
      ws.send_text(JSON.generate({ type: 'auth', token: register!['token'] }))
      loop do
        text = ws.read(timeout: @open_timeout) or raise WebSocket::Error, 'timed out waiting for ready'
        break if JSON.parse(text)['type'] == 'ready'
      end
      @socket = ws
    rescue StandardError
      ws&.shutdown
      raise
    end

    # The server pings every 30 s; we also ping after 30 s of silence and give
    # up on a connection that stays silent for another 30 s.
    def pump(ws)
      idle = 0
      until @stopping
        text = ws.read(timeout: 30)
        if text.nil?
          idle += 1
          raise WebSocket::Error, 'no response from the server' if idle > 1
          ws.ping
          next
        end
        idle = 0
        event = begin
          JSON.parse(text)
        rescue JSON::ParserError
          logger.warn('ignoring a malformed realtime event')
          next
        end
        yield event if event.is_a?(Hash)
      end
    end

    def sleep_unless_stopped(seconds)
      deadline = Time.now + seconds
      sleep(0.1) while !@stopping && Time.now < deadline
    end

    def headers(auth: true)
      h = { 'Accept' => 'application/json', 'User-Agent' => "tailchat-ruby/#{VERSION}" }
      h['X-Dev-User'] = @dev_user if @dev_user
      h['Authorization'] = "Bearer #{@state['token']}" if auth && @state
      h
    end

    def parse_response(res, method, path)
      body = res.body.to_s
      data = if res['Content-Type'].to_s.include?('json') && !body.empty?
               begin
                 JSON.parse(body)
               rescue JSON::ParserError
                 { 'error' => body[0, 200] }
               end
             else
               body.b
             end
      return data if res.is_a?(Net::HTTPSuccess)
      raise HTTPError.new(res.code.to_i, method, path, data.is_a?(Hash) ? data['error'] : res.message)
    end

    # Tailnet traffic goes straight to the peer: never through an HTTP proxy.
    def new_http(read_timeout: @read_timeout)
      http = Net::HTTP.new(@uri.host, @uri.port, nil)
      if @uri.scheme == 'https'
        http.use_ssl = true
        http.verify_mode = OpenSSL::SSL::VERIFY_PEER
        http.cert_store = @cert_store if @cert_store
      end
      http.open_timeout = @open_timeout
      http.read_timeout = read_timeout
      http.write_timeout = read_timeout
      http.keep_alive_timeout = 2
      http
    end

    def persistent_http
      @http ||= new_http.tap(&:start)
    end

    def reset_http
      @http&.finish if @http&.started?
    rescue IOError
      nil
    ensure
      @http = nil
    end

    def with_fresh_http(read_timeout:)
      http = new_http(read_timeout: read_timeout)
      http.start { yield http }
    end

    def seg(value)
      URI.encode_uri_component(value.to_s)
    end

    def quote(target)
      return target.quote if target.is_a?(Message)
      target.transform_keys(&:to_s)
    end

    def media_kind(mime)
      case mime.to_s
      when 'image/gif' then 'gif'
      when %r{\Aimage/} then 'image'
      when %r{\Avideo/} then 'video'
      when %r{\Aaudio/} then 'audio'
      else 'document'
      end
    end

    def open_source(source)
      case source
      when String, Pathname
        f = File.open(source.to_s, 'rb')
        [f, f.size, true]
      else
        size = source.respond_to?(:size) ? source.size : (raise ArgumentError, 'IO sources must respond to #size')
        size -= source.pos if source.respond_to?(:pos)
        [source, size, false]
      end
    end

    def system_content(raw)
      parsed = raw['payload'] && JSON.parse(raw['payload'])
      parsed.is_a?(Hash) ? parsed : {}
    rescue JSON::ParserError
      {}
    end

    # ---------- state file ----------

    def load_state
      return nil unless File.exist?(@state_path)
      mode = File.stat(@state_path).mode & 0o777
      if mode & 0o077 != 0
        logger.warn("#{@state_path} was readable by others (#{format('%o', mode)}); fixing to 0600")
        File.chmod(0o600, @state_path)
      end
      state = JSON.parse(File.read(@state_path, encoding: Encoding::UTF_8))
      unless state['server'] == @server
        raise Error, "#{@state_path} holds a device for #{state['server']}, not #{@server}; use another state: path"
      end
      state
    end

    def write_state(state)
      dir = File.dirname(@state_path)
      FileUtils.mkdir_p(dir, mode: 0o700)
      tmp = "#{@state_path}.#{Process.pid}.tmp"
      File.open(tmp, File::WRONLY | File::CREAT | File::EXCL, 0o600) do |f|
        f.write(JSON.pretty_generate(state))
        f.flush
        f.fsync
      end
      File.rename(tmp, @state_path)
    ensure
      File.unlink(tmp) if tmp && File.exist?(tmp)
    end
  end
end
