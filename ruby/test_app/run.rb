#!/usr/bin/env ruby
# frozen_string_literal: true

# ──────────────────────────────────────────────────────────────────────────────
# EZLLM Test App — Provider Config Server
#
# Loads the provider initializer, then serves the providers config page on
# http://localhost:9292/providers.
#
# Usage:
#   cd test_app
#   ruby run.rb                      # starts on :9292
#   ruby run.rb -p 3000              # custom port
#   EZ_API_KEY_ANTHROPIC=sk-... ruby run.rb  # with a key configured
# ──────────────────────────────────────────────────────────────────────────────

# Put ez_llm on the load path so this runs without RUBYLIB or bundle.
$LOAD_PATH.unshift File.expand_path("../ez_llm/lib", __dir__)

require "webrick"
require "erb"
require_relative "config/initializers/ez_llm_providers"

PORT = (ARGV.include?("-p") ? ARGV[ARGV.index("-p") + 1].to_i : 9292) || 9292

server = WEBrick::HTTPServer.new(Port: PORT, Logger: WEBrick::Log.new("/dev/null"), AccessLog: [])

# ── /providers — HTML config page ────────────────────────────────────────────
server.mount_proc "/providers" do |_req, res|
  providers = TestApp.registered_providers

  template_path = File.expand_path("app/views/providers.html.erb", __dir__)
  template = File.read(template_path)
  rendered = ERB.new(template, trim_mode: "-").result(binding)

  res["Content-Type"] = "text/html; charset=utf-8"
  res.body = rendered
end

# ── /providers.json — machine-readable registry dump ─────────────────────────
server.mount_proc "/providers.json" do |_req, res|
  providers = TestApp.registered_providers.map do |p|
    p.merge(configured: !!(p[:env_key] && ENV[p[:env_key]] && !ENV[p[:env_key]].empty?))
  end

  res["Content-Type"] = "application/json"
  res.body = JSON.pretty_generate(providers: providers)
end

# ── / — redirect to providers ────────────────────────────────────────────────
server.mount_proc "/" do |_req, res|
  res.redirect("/providers")
end

trap("INT") { server.shutdown }

puts <<~BANNER

  \e[1mEZLLM Test App\e[0m
  ─────────────────────────────────────────
  Providers page:  \e[4mhttp://localhost:#{PORT}/providers\e[0m
  JSON registry:   \e[4mhttp://localhost:#{PORT}/providers.json\e[0m

  Registered providers: #{TestApp.registered_providers.map { |p| p[:name] }.join(', ')}

BANNER

server.start
