#!/usr/bin/env ruby
# frozen_string_literal: true

# A runnable, framework-free example: a terminal agent that streams to stdout and
# can call one real tool. No Rails, no jobs, no transport library — just plain
# Ruby consuming ez_agent. This proves the framework is agnostic: define a tool
# that wraps your own code, call Loop#run, and print the events.
#
# Usage:
#   EZ_PROVIDER=anthropic EZ_MODEL=claude-sonnet-4-6 EZ_API_KEY=sk-... \
#     ruby examples/weather_cli.rb "What's the weather in Tokyo and Paris?"
#
# Any provider works — set EZ_PROVIDER/EZ_MODEL/EZ_API_KEY (and EZ_BASE_URL for
# OpenAI-compatible endpoints). With no args it runs a built-in prompt.

# Put both gems on the load path so this runs straight from a checkout without
# `bundle`. In a real app you'd just `require "ez_agent"` from your Gemfile.
$LOAD_PATH.unshift File.expand_path("../ez_llm/lib", __dir__)
$LOAD_PATH.unshift File.expand_path("../ez_agent/lib", __dir__)
require "ez_llm"
require "ez_agent"

# A tool is a thin wrapper over code you already have. Here it's a stub lookup;
# in a real app this would call your weather service / DB / HTTP client.
class GetWeather < EZAgent::Tool
  description "Look up the current weather for a city."
  param :city, :string, required: true, description: "City name, e.g. 'Tokyo'"

  WEATHER = {
    "tokyo" => "18°C, light rain",
    "paris" => "12°C, overcast",
    "cairo" => "33°C, sunny"
  }.freeze

  def perform(city:)
    forecast = WEATHER[city.downcase] || "no data for #{city}"
    { city: city, forecast: forecast }.to_json
  end
end

provider = (ENV["EZ_PROVIDER"] || "anthropic").to_sym
model = ENV["EZ_MODEL"] || EZLLM::ModelRegistry.default_model(provider)&.id
prompt = ARGV.join(" ")
prompt = "What's the weather in Tokyo and Paris?" if prompt.empty?

unless ENV["EZ_API_KEY"]
  warn "Set EZ_API_KEY (and optionally EZ_PROVIDER/EZ_MODEL/EZ_BASE_URL) to run against a live provider."
  warn "Example: EZ_PROVIDER=anthropic EZ_MODEL=claude-sonnet-4-6 EZ_API_KEY=sk-ant-... ruby examples/weather_cli.rb"
  exit 1
end

agent = EZAgent::Loop.new(
  provider: provider,
  model: model,
  system: "You are a concise weather assistant. Use the get_weather tool for each city.",
  tools: [GetWeather]
)

credentials = { api_key: ENV["EZ_API_KEY"], base_url: ENV["EZ_BASE_URL"] }

puts "\n\e[1m▶ #{prompt}\e[0m\n\n"

result = agent.run(messages: [{ role: "user", content: prompt }], credentials: credentials) do |event|
  case event.type
  when :thinking_delta
    print "\e[90m#{event.text}\e[0m"
  when :text_delta
    print event.text
  when :tool_call_start
    print "\n\e[36m⚙ #{event.name}(#{event.args.to_json})\e[0m\n"
  when :tool_call_end
    print "\e[32m← #{event.result}\e[0m\n\n"
  when :retry
    warn "\n\e[33m↻ retry (#{event.reason}) attempt #{event.attempt}/#{event.max_attempts}\e[0m"
  when :error
    warn "\n\e[31m✗ #{event.error.message}\e[0m"
  end
end

$stdout.flush
puts "\n\n\e[90m— done in #{result.total_turns} turn(s), " \
     "#{result.total_usage.input_tokens} in / #{result.total_usage.output_tokens} out tokens —\e[0m"
