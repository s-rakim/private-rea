# frozen_string_literal: true

module Tailchat
  # A bot account: the tailnet equivalent of a WhatsApp business/bot account.
  #
  #   bot = Tailchat::Bot.new(server: 'https://chat.example.ts.net', state: 'weather.json', name: 'Weather bot')
  #   bot.command('/weather', description: 'Forecast for a city') { |msg, args| msg.reply("Sunny in #{args}") }
  #   bot.on_message { |msg| msg.reply("Try /help") }
  #   bot.on_file { |msg, file| file.save('inbox') }
  #   bot.run
  #
  # Handlers run one at a time on the bot's dispatcher thread (scheduled jobs
  # too), so they never race each other. Every incoming message gets a
  # delivered receipt when it arrives and a read receipt once handled.
  # Messages that arrived while the bot was offline are handled on (re)connect.
  class Bot
    Command = Struct.new(:name, :aliases, :description, :handler)

    # A job from #at / #after; #cancel stops it from running.
    class Timer
      attr_reader :at, :block

      def initialize(at, block)
        @at = at.to_f
        @block = block
        @cancelled = false
      end

      def cancel = (@cancelled = true)
      def cancelled? = @cancelled
    end

    attr_reader :client, :logger

    # handle_own: what to do with messages your own tailnet user sends from
    # other devices. Bots run as a real user (tagged devices have no identity),
    # so the default, :self_chat, only answers them in your "message yourself"
    # chat. true answers them everywhere, false never.
    # catch_up: handle messages that arrived while the bot was offline.
    # Other options (server:, state:, dev_user:, logger:, …) go to Client.new;
    # name: is the device name.
    def initialize(client = nil, name: nil, handle_own: :self_chat, catch_up: true, **client_options)
      client_options[:device_name] ||= name if name
      @client = client || Client.new(**client_options)
      @logger = @client.logger
      @handle_own = handle_own
      @catch_up = catch_up
      @commands = {}
      @command_list = []
      @message_handlers = []
      @file_handlers = []
      @event_handlers = []
      @ready_handlers = []
      @error_handler = nil
      @queue = Queue.new
      @seen = {} # chat id -> highest seq handled
      @chats = {} # chat id -> chat view (for self-chat detection)
      @timers = []
      @timer_lock = Mutex.new
      @timer_cv = ConditionVariable.new
      @state_lock = Mutex.new
      @state_cv = ConditionVariable.new
      @ready = false
      @stopped = false
    end

    # ---------- DSL ----------

    # bot.command('/remind', '/r', description: '…') { |msg, args| … }
    # args is the text after the command, stripped ("" if none).
    def command(name, *aliases, description: nil, &handler)
      raise ArgumentError, 'command needs a block' unless handler
      cmd = Command.new(normalize(name), aliases.map { |a| normalize(a) }, description, handler)
      ([cmd.name] + cmd.aliases).each { |n| @commands[n] = cmd }
      @command_list << cmd
      cmd
    end

    # Messages that are not a known command (text, location, poll…). Also
    # gets files when there is no on_file handler.
    def on_message(&handler) = @message_handlers << handler

    # Media messages: the block gets the message and its Attachment.
    def on_file(&handler) = @file_handlers << handler

    # Every raw server event (Hash), e.g. "receipt", "typing", "user".
    def on_event(&handler) = @event_handlers << handler

    # After each (re)connect and catch-up.
    def on_ready(&handler) = @ready_handlers << handler

    # Called with (error, message_or_nil) when a handler raises. The default logs it.
    def on_error(&handler) = (@error_handler = handler)

    # Run a block on the dispatcher thread at `time` / after `seconds`.
    def at(time, &block)
      timer = Timer.new(time.is_a?(Time) ? time.to_f : time, block)
      @timer_lock.synchronize do
        @timers << timer
        @timers.sort_by!(&:at)
        @timer_cv.signal
      end
      timer
    end

    def after(seconds, &block) = at(Time.now.to_f + seconds, &block)

    # Send a text to a chat outside of a reply.
    def say(chat_id, text, **options) = client.send_text(chat_id, text, **options)

    # ---------- running ----------

    # Connects and handles messages until #stop (or Ctrl-C). Blocks.
    def run(trap_signals: Thread.current == Thread.main)
      if trap_signals
        %w[INT TERM].each { |sig| trap(sig) { Thread.new { stop } } }
      end
      client.register!
      logger.info("#{client.user_id} is online as device #{client.device_id}")
      listener = Thread.new { listen_loop }
      scheduler = Thread.new { timer_loop }
      dispatch_loop
    ensure
      stop
      listener&.join(5)
      scheduler&.join(5)
    end

    # Runs the bot on a background thread and returns self.
    def start
      @runner = Thread.new do
        run(trap_signals: false)
      rescue StandardError => e
        logger.error("bot stopped: #{e.class}: #{e.message}")
      end
      self
    end

    def stop
      return if @stopped
      @stopped = true
      client.stop
      @queue << [:stop]
      @timer_lock.synchronize { @timer_cv.broadcast }
      @state_lock.synchronize { @state_cv.broadcast }
    end

    def join(timeout = nil) = @runner&.join(timeout)

    # Blocks until the bot is connected and has caught up (for tests and scripts).
    def wait_until_ready(timeout = 10)
      deadline = Time.now + timeout
      @state_lock.synchronize do
        until @ready || @stopped
          left = deadline - Time.now
          raise Error, 'bot did not connect in time' if left <= 0
          @state_cv.wait(@state_lock, left)
        end
        raise Error, 'bot stopped before it was ready' unless @ready
      end
      self
    end

    def commands = @command_list.dup

    def help_text
      lines = @command_list.map do |c|
        names = ([c.name] + c.aliases).join(', ')
        c.description ? "#{names} - #{c.description}" : names
      end
      lines << '/help - this list' unless @commands.key?('/help')
      "Commands:\n#{lines.join("\n")}"
    end

    private

    def normalize(name)
      name = name.to_s.strip.downcase
      name.start_with?('/') ? name : "/#{name}"
    end

    def listen_loop
      client.listen { |event| @queue << [:event, event] }
    rescue StandardError => e
      @queue << [:fatal, e]
    end

    def timer_loop
      @timer_lock.synchronize do
        until @stopped
          now = Time.now.to_f
          @queue << [:timer, @timers.shift] while @timers.any? && @timers.first.at <= now
          wait = @timers.empty? ? nil : @timers.first.at - now
          @timer_cv.wait(@timer_lock, wait)
        end
      end
    end

    def dispatch_loop
      until @stopped
        kind, item = @queue.pop
        case kind
        when :stop then break
        when :fatal then raise item
        when :timer then guarded(nil) { item.block.call } unless item.cancelled?
        when :event then handle_event(item)
        end
      end
    end

    def handle_event(event)
      @event_handlers.each { |h| guarded(nil) { h.call(event) } }
      case event['type']
      when 'ready' then on_connected
      when 'message' then handle_raw(event['message'])
      when 'chat' then @chats[event['chat']['id']] = event['chat'] if event['chat'].is_a?(Hash)
      when 'chat-removed' then @chats.delete(event['chatId'])
      end
    rescue StandardError => e
      report(e, nil)
    end

    def on_connected
      catch_up if @catch_up
      @ready_handlers.each { |h| guarded(nil) { h.call } }
      @state_lock.synchronize do
        @ready = true
        @state_cv.broadcast
      end
    end

    # Handle what arrived while we were away: everything after our read receipt.
    def catch_up
      client.chats.each do |chat|
        @chats[chat['id']] = chat
        from = [chat.dig('me', 'readSeq').to_i, @seen[chat['id']].to_i].max
        next if from >= chat['lastSeq'].to_i
        loop do
          page = client.raw_messages(chat['id'], after: from, limit: 100)
          page['messages'].each do |raw|
            handle_raw(raw)
            from = [from, raw['seq']].max
          end
          break unless page['hasMore'] && page['messages'].any?
        end
      end
    end

    def handle_raw(raw)
      return unless raw.is_a?(Hash) && raw['kind'] == 'msg' && raw['payload']
      chat_id = raw['chatId']
      seq = raw['seq'].to_i
      return if @seen[chat_id].to_i >= seq
      @seen[chat_id] = seq
      return if raw['senderDevice'] == client.device_id
      return if raw['senderId'] == client.user_id && !answer_own?(chat_id)

      receipt(chat_id, delivered: seq)
      msg = client.open_message(raw)
      if msg.error
        logger.info("skipping message #{msg.id} in #{chat_id}: #{msg.error.message}")
      else
        dispatch(msg)
      end
      receipt(chat_id, read: seq)
    end

    def dispatch(msg)
      if msg.text? && (parsed = parse_command(msg.text))
        name, args = parsed
        if (cmd = @commands[name])
          return guarded(msg) { cmd.handler.call(msg, args) }
        elsif name == '/help'
          return guarded(msg) { msg.reply(help_text) }
        end
      end
      if msg.attachment && @file_handlers.any?
        @file_handlers.each { |h| guarded(msg) { h.call(msg, msg.attachment) } }
      elsif @message_handlers.any?
        @message_handlers.each { |h| guarded(msg) { h.call(msg) } }
      elsif parsed
        guarded(msg) { msg.reply("I don't know #{parsed[0]}. Send /help for what I can do.") }
      end
    end

    # "/Remind@bot 10m tea" -> ["/remind", "10m tea"]
    def parse_command(text)
      m = text.strip.match(%r{\A(/[\p{L}\p{N}_-]+)(?:@\S+)?(?:\s+(.*))?\z}m) or return nil
      [m[1].downcase, m[2].to_s.strip]
    end

    def answer_own?(chat_id)
      return @handle_own if [true, false].include?(@handle_own)
      chat = (@chats[chat_id] ||= client.chat(chat_id))
      chat['type'] == 'direct' && chat['members'].map { |m| m['userId'] }.uniq == [client.user_id]
    end

    def receipt(chat_id, **seqs)
      client.receipts(chat_id, **seqs)
    rescue StandardError => e
      logger.warn("receipt for #{chat_id} failed: #{e.message}")
    end

    def guarded(msg)
      yield
    rescue StandardError => e
      report(e, msg)
    end

    def report(error, msg)
      if @error_handler
        @error_handler.call(error, msg)
      else
        logger.error("handler failed#{msg ? " for message #{msg.id}" : ''}: #{error.class}: #{error.message}")
        logger.debug(error.backtrace&.first(10)&.join("\n"))
      end
    rescue StandardError => e
      logger.error("on_error handler failed: #{e.message}")
    end
  end
end
