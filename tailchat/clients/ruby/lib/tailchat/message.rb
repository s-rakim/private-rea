# frozen_string_literal: true

module Tailchat
  # A chat message as the server sent it, plus its decrypted content.
  class Message
    attr_reader :raw, :content, :error, :client

    def initialize(raw, client:, content: nil, error: nil)
      @raw = raw
      @client = client
      @content = content || {}
      @error = error
    end

    def id = raw['id']
    def chat_id = raw['chatId']
    def seq = raw['seq']
    def sender_id = raw['senderId']
    def sender_device = raw['senderDevice']
    def kind = raw['kind']
    def files = raw['files'] || []
    def created_at = raw['createdAt'] && Time.at(raw['createdAt'] / 1000.0)
    def edited? = !raw['editedAt'].nil?
    def deleted? = !raw['deletedAt'].nil?
    def view_once? = raw['viewOnce'] == true

    # Decrypted and from a person (not a system notice or deleted message).
    def readable? = error.nil? && kind == 'msg' && !deleted?
    def system? = kind == 'system'
    def type = content['type']
    def text? = type == 'text'
    def media? = type == 'media'

    # The text of a text message, or a media message's caption.
    def text
      content['text'] || content['caption']
    end

    def reply_to = content['replyTo']
    def mine? = client && sender_device == client.device_id

    def attachment
      return nil unless media? && content['file'].is_a?(Hash)
      @attachment ||= Attachment.new(content['file'], content, client)
    end

    # The `replyTo` object for a reply quoting this message (§4).
    def quote
      preview = if text && !text.empty? then text
                elsif attachment then "#{content['kind'] || 'file'}: #{attachment.name}"
                else type.to_s
                end
      { 'id' => id, 'senderId' => sender_id, 'preview' => preview[0, 100] }
    end

    def reply(text, **extra)
      client.send_text(chat_id, text, reply_to: self, **extra)
    end

    def reply_file(source, **options)
      client.send_file(chat_id, source, reply_to: self, **options)
    end

    def react(emoji)
      client.react(id, emoji)
    end

    def inspect
      "#<Tailchat::Message #{id} chat=#{chat_id} seq=#{seq} from=#{sender_id} #{error ? "error=#{error.message}" : content.inspect}>"
    end
  end

  # An encrypted file referenced by a media message (§5).
  class Attachment
    attr_reader :file, :content, :client

    def initialize(file, content, client)
      @file = file
      @content = content
      @client = client
    end

    def id = file['id']
    def size = file['size']
    def mime = file['mime'] || 'application/octet-stream'
    def kind = content['kind']
    def caption = content['caption']

    # The sender-chosen name. Never use it as a path as-is: see #safe_name.
    def name = file['name'].to_s

    # A file name that is safe to create inside a directory of your choice.
    def safe_name
      Attachment.sanitize(name)
    end

    def self.sanitize(name)
      base = name.to_s.encode(Encoding::UTF_8, invalid: :replace, undef: :replace).split(%r{[/\\]}).last.to_s
      base = base.gsub(/[[:cntrl:]]/, '').gsub(/[^\p{L}\p{N} ._()+,=@-]/, '_').strip.sub(/\A[.\s]+/, '')
      base = base.byteslice(0, 120).scrub('') while base.bytesize > 120
      base.empty? ? 'file' : base
    end

    # Downloads and decrypts the whole file into memory.
    def read
      client.read_file(file)
    end

    # Downloads into `io` (anything with #write), decrypting as it streams.
    def download(io)
      client.download_file(file, io)
    end

    # Saves into `dir` (created if needed) under a sanitised, unique name and
    # returns the path. Never overwrites or follows an existing file.
    def save(dir, name: safe_name)
      FileUtils.mkdir_p(dir)
      tmp = File.join(dir, ".#{Crypto.b64u(Crypto.random_bytes(9))}.part")
      File.open(tmp, File::WRONLY | File::CREAT | File::EXCL, 0o600) do |f|
        f.binmode
        download(f)
        f.flush
        f.fsync
      end
      place(tmp, dir, name)
    ensure
      File.unlink(tmp) if tmp && File.exist?(tmp)
    end

    private

    def place(tmp, dir, name)
      ext = File.extname(name)
      stem = File.basename(name, ext)
      (0..).each do |n|
        candidate = File.join(dir, n.zero? ? name : "#{stem} (#{n})#{ext}")
        begin
          File.link(tmp, candidate) # atomic and refuses to replace an existing entry
          return candidate
        rescue Errno::EEXIST
          next
        rescue NotImplementedError, Errno::EPERM, Errno::EOPNOTSUPP # no hard links on this filesystem
          next if File.exist?(candidate)
          File.rename(tmp, candidate)
          return candidate
        end
      end
    end
  end
end
