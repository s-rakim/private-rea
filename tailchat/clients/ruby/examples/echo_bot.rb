#!/usr/bin/env ruby
# frozen_string_literal: true

# Echo bot: replies to every text with the same text, and sends files straight
# back (re-using the uploaded, still encrypted blob).
#
#   TAILCHAT_SERVER=https://chat.example.ts.net ruby examples/echo_bot.rb
#   TAILCHAT_SERVER=http://127.0.0.1:8443 TAILCHAT_DEV_USER=echobot ruby examples/echo_bot.rb   # dev mode
require_relative '../lib/tailchat'

module EchoBot
  def self.build(**options)
    bot = Tailchat::Bot.new(name: 'Echo bot', **options)

    bot.command('/start', description: 'What I do') do |msg, _args|
      msg.reply('Hi! Send me any text or file and I will send it right back.')
    end

    bot.on_message do |msg|
      if msg.text?
        msg.reply(msg.text)
      else
        msg.reply("I can only echo text and files (got a #{msg.type} message).")
      end
    end

    # The file key travels inside the encrypted content, so the bot can send
    # the same blob back without downloading or re-uploading it.
    bot.on_file do |msg, file|
      msg.client.send_content(msg.chat_id, msg.content.merge('replyTo' => msg.quote), files: [file.id])
    end

    bot
  end
end

EchoBot.build(**Tailchat::Bot.env_options('echo_bot')).run if $PROGRAM_NAME == __FILE__
