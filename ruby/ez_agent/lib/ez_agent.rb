# frozen_string_literal: true

require "zeitwerk"
require "set"
require "ez_llm"

# EZAgent — a framework-agnostic, streaming, tool-calling agent loop for Ruby.
#
# Standalone port of @prestyj/agent + media-master's hardening. Define tools as
# Ruby classes that wrap your own code, call Loop#run, and consume the events it
# yields. No Rails, no job backend, no transport — the consumer owns concurrency
# and where events go.
module EZAgent
  class << self
    attr_reader :loader
  end

  @loader = Zeitwerk::Loader.for_gem
  @loader.inflector.inflect("ez_agent" => "EZAgent")
  @loader.ignore("#{__dir__}/ez_agent/version.rb")
  @loader.setup

  require_relative "ez_agent/version"

  def self.eager_load!
    @loader.eager_load
  end
end
