# frozen_string_literal: true

# Runs every test: ruby test/run.rb  (from tailchat/clients/ruby)
Dir[File.join(__dir__, '*_test.rb')].sort.each { |f| require f }
