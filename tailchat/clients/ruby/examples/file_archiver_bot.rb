#!/usr/bin/env ruby
# frozen_string_literal: true

# File archiver bot: saves every file shared with it (directly or in a group)
# into ARCHIVE_DIR/<sender>/, decrypting as it downloads.
#
#   ARCHIVE_DIR=~/tailchat-archive TAILCHAT_SERVER=https://chat.example.ts.net ruby examples/file_archiver_bot.rb
require_relative '../lib/tailchat'

module FileArchiverBot
  def self.human_size(bytes)
    units = %w[B KB MB GB TB]
    size = bytes.to_f
    unit = 0
    while size >= 1024 && unit < units.size - 1
      size /= 1024
      unit += 1
    end
    unit.zero? ? "#{bytes} B" : format('%.1f %s', size, units[unit])
  end

  def self.build(dir: ENV['ARCHIVE_DIR'] || File.join(Dir.home, 'tailchat-archive'), **options)
    dir = File.expand_path(dir)
    bot = Tailchat::Bot.new(name: 'File archiver', **options)
    folder = ->(msg) { File.join(dir, Tailchat::Attachment.sanitize(msg.sender_id)) }

    bot.on_file do |msg, file|
      # Keeping a copy would defeat the point of view-once media.
      next msg.reply("I don't archive view-once media.") if msg.view_once?

      path = file.save(folder.call(msg)) # sanitised name, never overwrites
      bot.logger.info("archived #{path} (#{file.size} bytes) from #{msg.sender_id}")
      msg.reply("Archived #{File.basename(path)} (#{human_size(file.size)}).")
    end

    bot.command('/stats', description: 'How much I have archived for you') do |msg, _args|
      files = Dir.glob(File.join(folder.call(msg), '*')).select { |f| File.file?(f) }
      msg.reply("#{files.size} file#{files.size == 1 ? '' : 's'}, #{human_size(files.sum { |f| File.size(f) })} archived for you.")
    end

    bot.on_message { |msg| msg.reply('Send me any file and I will archive it. /stats shows what I have.') }
    bot
  end
end

FileArchiverBot.build(**Tailchat::Bot.env_options('file_archiver_bot')).run if $PROGRAM_NAME == __FILE__
