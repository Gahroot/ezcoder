# frozen_string_literal: true

module EZAgent
  # Holds the tools available to one run, indexed by name, and produces the
  # provider-facing tool definitions. Accepts tool instances or tool classes
  # (classes are instantiated with no args). Later registrations win on a name
  # collision, mirroring agentTools/index.ts's merge-and-dispatch.
  class ToolRegistry
    def initialize(tools = [])
      @tools = {}
      Array(tools).each { |tool| register(tool) }
    end

    # Register a tool instance or class. Returns the registry for chaining.
    def register(tool)
      instance = tool.is_a?(Class) ? tool.new : tool
      @tools[instance.name] = instance
      self
    end

    def merge(other_tools)
      Array(other_tools).each { |tool| register(tool) }
      self
    end

    def get(name)
      @tools[name.to_s]
    end

    def key?(name)
      @tools.key?(name.to_s)
    end

    def names
      @tools.keys
    end

    def tools
      @tools.values
    end

    def empty?
      @tools.empty?
    end

    # Provider-facing EZLLM::Tool definitions for every registered tool.
    def to_llm_tools
      @tools.values.map(&:to_llm_tool)
    end
  end
end
