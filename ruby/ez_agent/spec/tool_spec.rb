# frozen_string_literal: true

class WeatherTool < EZAgent::Tool
  description "Look up current weather."
  param :city, :string, required: true, description: "City name"
  param :units, :string, enum: %w[metric imperial]

  def perform(city:, units: "metric")
    "#{city}:#{units}"
  end
end

class ContextTool < EZAgent::Tool
  description "Echoes the consumer context."
  param :key, :string, required: true

  def perform(key:, context:)
    context.context.fetch(key.to_sym, "missing").to_s
  end
end

RSpec.describe EZAgent::Tool do
  it "derives a snake_case tool name and builds an EZLLM tool definition" do
    expect(WeatherTool.tool_name).to eq("weather_tool")
    llm = WeatherTool.to_llm_tool
    expect(llm).to be_a(EZLLM::Tool)
    expect(llm.input_schema["required"]).to eq(["city"])
    expect(llm.input_schema.dig("properties", "units", "enum")).to eq(%w[metric imperial])
  end

  it "calls #perform with parsed kwargs" do
    expect(WeatherTool.new.call({ "city" => "Tokyo", "units" => "imperial" }, nil)).to eq("Tokyo:imperial")
  end

  it "threads the ToolContext only when #perform declares context:" do
    ctx = EZAgent::ToolContext.new(tool_call_id: "t1", context: { user: "ada" })
    expect(ContextTool.new.call({ "key" => "user" }, ctx)).to eq("ada")
  end

  it "exposes hardening flags via macros" do
    klass = Class.new(EZAgent::Tool) do
      description "x"
      requires_confirmation!
      untrusted!
      sequential!
    end
    expect(klass.requires_confirmation?).to be(true)
    expect(klass.untrusted?).to be(true)
    expect(klass.execution_mode).to eq(:sequential)
  end
end

RSpec.describe EZAgent::ToolRegistry do
  it "registers instances and classes and dispatches by name" do
    registry = described_class.new([WeatherTool])
    registry.register(ContextTool.new)
    expect(registry.names).to contain_exactly("weather_tool", "context_tool")
    expect(registry.get("weather_tool")).to be_a(WeatherTool)
    expect(registry.to_llm_tools.map(&:name)).to include("weather_tool")
  end
end
