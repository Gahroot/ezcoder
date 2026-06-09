# frozen_string_literal: true

module EZLLM
  # A provider-facing tool definition: a name, a description, and a JSON Schema
  # for its parameters (already normalized for Anthropic's root rules). The agent
  # layer builds these from its richer tool classes; consumers calling
  # EZLLM.stream directly can construct them from a ToolSchema.
  #
  #   EZLLM::Tool.new(
  #     name: "get_weather",
  #     description: "Look up current weather.",
  #     input_schema: EZLLM::ToolSchema.build { string :city, required: true }.to_json_schema
  #   )
  Tool = Data.define(:name, :description, :input_schema)
end
