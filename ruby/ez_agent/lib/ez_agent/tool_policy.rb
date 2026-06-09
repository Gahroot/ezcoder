# frozen_string_literal: true

module EZAgent
  # Classifies tools as auto-executable vs. confirmation-gated. A tool requires
  # confirmation if EITHER it opted in via the `requires_confirmation!` macro OR
  # its name is in the policy's explicit `requires_confirmation` set. New tools
  # default to auto, so gating an external-write tool is a deliberate act —
  # that's the security property (OWASP LLM06, excessive agency).
  #
  # Port of toolPolicy.ts (classifyTool).
  class ToolPolicy
    def initialize(requires_confirmation: [])
      @gated_names = Array(requires_confirmation).map(&:to_s).to_set
    end

    # True if a call to `tool_name` must pass the approval gate. `tool` is the
    # resolved tool instance (or nil for unknown tools).
    def requires_confirmation?(tool_name, tool = nil)
      return true if @gated_names.include?(tool_name.to_s)

      tool.respond_to?(:requires_confirmation?) && tool.requires_confirmation?
    end

    def gated_names
      @gated_names.to_a.sort
    end
  end
end
