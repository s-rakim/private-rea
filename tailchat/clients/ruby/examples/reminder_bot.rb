#!/usr/bin/env ruby
# frozen_string_literal: true

# Reminder bot: "/remind 10m take a break" answers in ten minutes, quoting
# your message. Pending reminders survive restarts (REMINDER_STORE).
#
#   TAILCHAT_SERVER=https://chat.example.ts.net ruby examples/reminder_bot.rb
#
# Runs as a real tailnet user, so its owner can also use it from any of their
# devices in the "message yourself" chat.
require 'json'
require_relative '../lib/tailchat'

module ReminderBot
  UNITS = { 's' => 1, 'm' => 60, 'h' => 3600, 'd' => 86_400, 'w' => 604_800 }.freeze
  NAMES = [[604_800, 'week'], [86_400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']].freeze
  MAX = 365 * 86_400
  USAGE = 'Usage: /remind <when> <what>, e.g. /remind 10m take a break (s, m, h, d, w; 1h30m works too)'

  # "1h30m" -> 5400; nil if it isn't a duration.
  def self.parse_duration(text)
    return nil unless text.to_s.match?(/\A(?:\d+[smhdw])+\z/i)
    text.downcase.scan(/(\d+)([smhdw])/).sum { |n, unit| n.to_i * UNITS[unit] }
  end

  def self.humanize(seconds)
    seconds = seconds.round
    parts = NAMES.filter_map do |size, name|
      count, seconds = seconds.divmod(size)
      "#{count} #{name}#{count == 1 ? '' : 's'}" if count.positive?
    end
    parts.empty? ? 'a moment' : parts.first(2).join(' ')
  end

  # Pending reminders in a JSON file, written atomically.
  class Store
    def initialize(path)
      @path = path
      @items = File.exist?(path) ? JSON.parse(File.read(path, encoding: Encoding::UTF_8)) : []
    end

    def all = @items.dup

    def add(item)
      @items << item
      save
    end

    def delete(id)
      @items.reject! { |r| r['id'] == id }
      save
    end

    private

    def save
      FileUtils.mkdir_p(File.dirname(@path))
      tmp = "#{@path}.tmp"
      File.write(tmp, JSON.pretty_generate(@items), perm: 0o600)
      File.rename(tmp, @path)
    end
  end

  def self.build(store: ENV['REMINDER_STORE'] || File.join(Dir.home, '.tailchat', 'reminders.json'), **options)
    bot = Tailchat::Bot.new(name: 'Reminder bot', **options)
    reminders = Store.new(store)
    timers = {}

    fire = lambda do |r|
      timers.delete(r['id'])
      bot.say(r['chatId'], "⏰ Reminder: #{r['text']}", reply_to: r['replyTo'])
      reminders.delete(r['id'])
    rescue StandardError => e
      bot.logger.warn("reminder #{r['id']} failed (#{e.message}); retrying in 30s")
      timers[r['id']] = bot.after(30) { fire.call(r) }
    end
    schedule = ->(r) { timers[r['id']] = bot.at(r['at']) { fire.call(r) } }
    reminders.all.each(&schedule) # overdue ones fire as soon as the bot runs

    bot.command('/remind', description: 'Remind you later: /remind 10m take a break') do |msg, args|
      wait, what = args.split(/\s+/, 2)
      seconds = parse_duration(wait)
      next msg.reply(USAGE) if seconds.nil? || seconds.zero? || what.to_s.strip.empty?
      next msg.reply("That's too far away; the most I can do is #{humanize(MAX)}.") if seconds > MAX

      r = {
        'id' => Tailchat::Crypto.new_message_id, 'chatId' => msg.chat_id, 'for' => msg.sender_id,
        'at' => Time.now.to_f + seconds, 'text' => what.strip, 'replyTo' => msg.quote,
      }
      reminders.add(r)
      schedule.call(r)
      msg.reply("OK, I'll remind you in #{humanize(seconds)}.")
    end

    bot.command('/reminders', description: 'Pending reminders in this chat') do |msg, _args|
      mine = reminders.all.select { |r| r['chatId'] == msg.chat_id }.sort_by { |r| r['at'] }
      next msg.reply('No reminders pending here.') if mine.empty?
      lines = mine.map { |r| "• in #{humanize(r['at'] - Time.now.to_f)}: #{r['text']}" }
      msg.reply("Pending reminders:\n#{lines.join("\n")}")
    end

    bot.command('/cancel', description: 'Cancel your reminders in this chat') do |msg, _args|
      mine = reminders.all.select { |r| r['chatId'] == msg.chat_id && r['for'] == msg.sender_id }
      mine.each do |r|
        timers.delete(r['id'])&.cancel
        reminders.delete(r['id'])
      end
      msg.reply(mine.empty? ? 'You have no reminders here.' : "Cancelled #{mine.size} reminder#{mine.size == 1 ? '' : 's'}.")
    end

    bot.on_message { |msg| msg.reply("I set reminders. #{USAGE}") }
    bot
  end
end

ReminderBot.build(**Tailchat::Bot.env_options('reminder_bot')).run if $PROGRAM_NAME == __FILE__
