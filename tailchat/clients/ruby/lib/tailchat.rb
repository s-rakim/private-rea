# frozen_string_literal: true

# Tailchat for Ruby: an end-to-end encrypted client and bot framework for
# Tailchat servers on your Tailscale tailnet. Standard library only.
module Tailchat
  VERSION = '0.1.0'
end

require_relative 'tailchat/crypto'
require_relative 'tailchat/websocket'
require_relative 'tailchat/message'
require_relative 'tailchat/client'
require_relative 'tailchat/bot'
