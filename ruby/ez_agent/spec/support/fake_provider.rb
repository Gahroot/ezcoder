# frozen_string_literal: true

# Registers a scripted provider into the EZLLM registry so the agent loop can be
# driven without any network. Each call to the loop's LLM step pops the next
# scripted response (a proc that emits events and returns an EZLLM::Response, or
# raises to simulate an error). This is the Ruby analogue of the TS palsu/test
# provider.
module FakeProvider
  RESPONSES = []
  CALLS = []

  module_function

  def install!(name: :fake)
    EZLLM::ProviderRegistry.register(name) do |request, &on_event|
      CALLS << request
      script = RESPONSES.shift
      raise "no scripted response left" unless script

      script.call(request, on_event)
    end
  end

  def reset!
    RESPONSES.clear
    CALLS.clear
  end

  # Script a turn that streams text then ends.
  def text(str, stop_reason: "end_turn", usage: EZLLM::Usage.new(input_tokens: 1, output_tokens: 1))
    RESPONSES << lambda do |_req, on_event|
      on_event&.call(EZLLM::Event::TextDelta.new(text: str))
      on_event&.call(EZLLM::Event::Done.new(stop_reason: stop_reason))
      EZLLM::Response.new(message: { role: "assistant", content: [EZLLM::Types.text(str)] },
                          stop_reason: stop_reason, usage: usage)
    end
  end

  # Script a turn that calls a tool.
  def tool_call(id:, name:, args:, text: nil)
    RESPONSES << lambda do |_req, on_event|
      content = []
      if text
        on_event&.call(EZLLM::Event::TextDelta.new(text: text))
        content << EZLLM::Types.text(text)
      end
      on_event&.call(EZLLM::Event::ToolCallDone.new(id: id, name: name, args: args))
      content << EZLLM::Types.tool_call(id: id, name: name, args: args)
      on_event&.call(EZLLM::Event::Done.new(stop_reason: "tool_use"))
      EZLLM::Response.new(message: { role: "assistant", content: content },
                          stop_reason: "tool_use", usage: EZLLM::Usage.new(input_tokens: 2, output_tokens: 2))
    end
  end

  # Script a raised error (e.g. to simulate overload/stall).
  def error(err)
    RESPONSES << ->(_req, _on_event) { raise err }
  end

  # Script an empty (degenerate) response.
  def empty
    RESPONSES << lambda do |_req, on_event|
      on_event&.call(EZLLM::Event::Done.new(stop_reason: "end_turn"))
      EZLLM::Response.new(message: { role: "assistant", content: "" },
                          stop_reason: "end_turn", usage: EZLLM::Usage.new)
    end
  end
end
