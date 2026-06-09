#!/usr/bin/env ruby
# frozen_string_literal: true

# ──────────────────────────────────────────────────────────────────────────────
# Smoke test — loads the initializer and verifies every provider is registered
# with a credentials resolver. Run from the test_app directory:
#
#   ruby verify.rb
# ──────────────────────────────────────────────────────────────────────────────

# Put ez_llm on the load path so this runs without RUBYLIB or bundle.
$LOAD_PATH.unshift File.expand_path("../ez_llm/lib", __dir__)

require_relative "config/initializers/ez_llm_providers"

EXPECTED_PROVIDERS = %i[anthropic openai gemini moonshot deepseek glm openrouter xiaomi minimax].freeze
errors = []

puts "EZLLM Provider Initializer — Verification"
puts "=" * 50

# 1. Check all providers are in the registry
puts "\n▸ Provider Registry"
EXPECTED_PROVIDERS.each do |name|
  registered = EZLLM::ProviderRegistry.has?(name)
  status = registered ? "✓" : "✗"
  puts "  #{status} #{name}"
  errors << "#{name} not in ProviderRegistry" unless registered
end

# 2. Check credentials resolver returns correct ENV keys
puts "\n▸ Credentials Resolver"
EXPECTED_PROVIDERS.each do |name|
  creds = TestApp.credentials_for(name)
  env_key = "EZ_API_KEY_#{TestApp::PROVIDER_CONFIGS[name][:env_suffix]}"
  puts "  #{name} → env_key=#{env_key}, resolved=#{creds.inspect}"
  errors << "#{name} resolver did not return a Hash" unless creds.is_a?(Hash)
end

# 3. Check default models exist
puts "\n▸ Default Models"
EXPECTED_PROVIDERS.each do |name|
  model = EZLLM::ModelRegistry.default_model(name)
  if model
    puts "  #{name} → #{model.id} (#{model.name})"
  else
    puts "  ✗ #{name} → NO DEFAULT MODEL"
    errors << "#{name} has no default model in ModelRegistry"
  end
end

# 4. Check provider count matches
registered_count = EZLLM::ProviderRegistry.list.size
puts "\n▸ Summary"
puts "  Providers in registry: #{registered_count}"
puts "  Expected:              #{EXPECTED_PROVIDERS.size}"
puts "  Total models:          #{EZLLM::ModelRegistry.all.size}"

if errors.empty?
  puts "\n\e[32m✓ All checks passed\e[0m"
  exit 0
else
  puts "\n\e[31m✗ #{errors.size} error(s):\e[0m"
  errors.each { |e| puts "  - #{e}" }
  exit 1
end
