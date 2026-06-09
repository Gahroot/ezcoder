# frozen_string_literal: true

module EZAgent
  # Base class for agent tools. A tool is a thin Ruby wrapper over code the app
  # already has — define the schema with class-level macros and implement
  # #perform. The agent runs in-process, so #perform just calls your service
  # object / DB / HTTP / anything and returns a String (or a structured result).
  #
  #   class GetWeather < EZAgent::Tool
  #     description "Look up current weather."
  #     param :city, :string, required: true, description: "City name"
  #     param :units, :string, enum: %w[metric imperial]
  #
  #     def perform(city:, units: "metric")
  #       Weather.for(city, units: units).to_json   # wraps your own code
  #     end
  #   end
  #
  # Optional hardening macros:
  #   requires_confirmation!  — gate this tool behind the approval gate (if any)
  #   untrusted!              — fence this tool's output before it enters history
  #   sequential!             — run in source order (no racing with other tools)
  #
  # Port of AgentTool + the param/description decorators.
  class Tool
    class << self
      # Set or read the human-facing description sent to the model.
      def description(text = nil)
        if text.nil?
          @description || ""
        else
          @description = text
        end
      end

      # Override the wire tool name (defaults to a snake_case of the class name).
      def tool_name(name = nil)
        if name.nil?
          @tool_name || default_tool_name
        else
          @tool_name = name.to_s
        end
      end

      # Declare a parameter. `kind` is one of the ToolSchema scalar/array/object
      # types; extra options (required:, description:, enum:, items:) pass through.
      def param(name, kind, **opts, &block)
        param_defs << { name: name, kind: kind, opts: opts, block: block }
      end

      def param_defs
        @param_defs ||= []
      end

      # Mark this tool as requiring human confirmation when a gate is present.
      def requires_confirmation!
        @requires_confirmation = true
      end

      def requires_confirmation?
        @requires_confirmation == true
      end

      # Mark this tool's output as untrusted (third-party content). When fencing
      # is enabled, results are wrapped before entering message history.
      def untrusted!
        @untrusted = true
      end

      def untrusted?
        @untrusted == true
      end

      # Force sequential execution for this tool (stateful mutations).
      def sequential!
        @execution_mode = :sequential
      end

      def execution_mode
        @execution_mode || :parallel
      end

      # Compile the declared params into an EZLLM::ToolSchema.
      def schema
        @schema ||= begin
          defs = param_defs
          EZLLM::ToolSchema.build do
            defs.each do |d|
              if d[:block]
                public_send(d[:kind], d[:name], **d[:opts], &d[:block])
              else
                public_send(d[:kind], d[:name], **d[:opts])
              end
            end
          end
        end
      end

      # The provider-facing EZLLM::Tool definition for this tool class.
      def to_llm_tool
        EZLLM::Tool.new(name: tool_name, description: description,
                        input_schema: schema.to_json_schema)
      end

      # Inherit accumulated config so subclasses start from a clean slate but
      # still pick up nothing implicit from siblings.
      def inherited(subclass)
        super
        subclass.instance_variable_set(:@param_defs, [])
      end

      private

      def default_tool_name
        name.to_s.split("::").last.gsub(/([a-z\d])([A-Z])/, '\1_\2').downcase
      end
    end

    # Instance-side conveniences delegating to class config.
    def name
      self.class.tool_name
    end

    def description
      self.class.description
    end

    def schema
      self.class.schema
    end

    def to_llm_tool
      self.class.to_llm_tool
    end

    def requires_confirmation?
      self.class.requires_confirmation?
    end

    def untrusted?
      self.class.untrusted?
    end

    def execution_mode
      self.class.execution_mode
    end

    # Subclasses implement. Receives validated params as keyword args plus, when
    # the method accepts it, the ToolContext. Return a String or a Hash like
    # `{ content: "...", details: {...} }`.
    def perform(**_args)
      raise NotImplementedError, "#{self.class} must implement #perform"
    end

    # Invoke #perform with the parsed args and context. Threads the context only
    # when #perform declares a `context:` keyword, so simple tools stay clean.
    def call(args, context)
      kwargs = symbolize(args)
      if accepts_context?
        perform(**kwargs, context: context)
      else
        perform(**kwargs)
      end
    end

    private

    def accepts_context?
      method(:perform).parameters.any? { |type, name| name == :context && %i[key keyreq].include?(type) }
    end

    def symbolize(args)
      args.each_with_object({}) { |(k, v), h| h[k.to_sym] = v }
    end
  end
end
