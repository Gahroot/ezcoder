# frozen_string_literal: true

module EZLLM
  # A small parameter DSL that compiles to JSON Schema for provider tool
  # definitions. This is the Ruby replacement for ezcoder's own
  # zod-to-json-schema converter: we own the schema emission so we can honor
  # provider quirks directly (notably Anthropic's `input_schema` rules — the
  # root must be `type: "object"` and must not carry top-level oneOf/anyOf/allOf).
  #
  # Build a schema with the block DSL:
  #
  #   schema = EZLLM::ToolSchema.build do
  #     string :city, required: true, description: "City to look up"
  #     integer :days, description: "Forecast horizon"
  #     string :units, enum: %w[metric imperial]
  #     array :tags, items: :string
  #     object :filter do
  #       boolean :open_now
  #     end
  #   end
  #   schema.to_json_schema # => { "type" => "object", "properties" => {...}, ... }
  #
  # A raw JSON Schema Hash can also be wrapped directly (e.g. for MCP tools) via
  # ToolSchema.raw(hash) — it bypasses the DSL but still gets root normalization.
  class ToolSchema
    SCALAR_TYPES = {
      string: "string", integer: "integer", number: "number",
      boolean: "boolean", null: "null"
    }.freeze

    # Build a schema from the DSL block. Returns a ToolSchema.
    def self.build(&block)
      builder = Builder.new
      builder.instance_eval(&block) if block
      new(builder.to_schema)
    end

    # Wrap a pre-built JSON Schema Hash (e.g. from an MCP tool). String or symbol
    # keys are accepted; output is normalized to string keys for the root.
    def self.raw(hash)
      new(stringify(hash))
    end

    def self.stringify(value)
      case value
      when Hash then value.to_h { |k, v| [k.to_s, stringify(v)] }
      when Array then value.map { |v| stringify(v) }
      else value
      end
    end

    attr_reader :schema

    def initialize(schema)
      @schema = schema
    end

    # JSON Schema with the Anthropic root-object normalization applied.
    def to_json_schema
      self.class.normalize_root_for_anthropic(@schema)
    end

    # Validate args against the schema's required keys and declared types,
    # returning [coerced_args, errors]. This is intentionally lightweight — a
    # model hint, not a full validator — mirroring how the TS side leans on the
    # schema for shape while the tool body owns deep validation.
    def validate(args)
      args = args.is_a?(Hash) ? args : {}
      args = args.transform_keys(&:to_s)
      errors = []
      props = @schema["properties"] || {}
      required = @schema["required"] || []

      required.each do |key|
        errors << "field `#{key}`: required" unless args.key?(key)
      end
      args.each do |key, value|
        prop = props[key]
        next unless prop

        type = prop["type"]
        next if type.nil? || value.nil?

        unless type_matches?(type, value)
          errors << "field `#{key}`: expected #{type}, received #{json_type(value)}"
        end
      end
      [args, errors]
    end

    def type_matches?(type, value)
      case type
      when "string" then value.is_a?(String)
      when "integer" then value.is_a?(Integer)
      when "number" then value.is_a?(Numeric)
      when "boolean" then [true, false].include?(value)
      when "array" then value.is_a?(Array)
      when "object" then value.is_a?(Hash)
      when "null" then value.nil?
      else true
      end
    end

    def json_type(value)
      case value
      when String then "string"
      when Integer then "integer"
      when Numeric then "number"
      when true, false then "boolean"
      when Array then "array"
      when Hash then "object"
      when nil then "null"
      else value.class.name.downcase
      end
    end

    # Collapse a root discriminated/plain union into a single flat object schema.
    # Anthropic rejects top-level oneOf/anyOf/allOf and a missing root type; this
    # mirrors normalizeRootForAnthropic from zod-to-json-schema.ts.
    def self.normalize_root_for_anthropic(schema)
      branches = schema["oneOf"] || schema["anyOf"]
      return schema if branches.nil? || branches.empty?

      unless branches.all? { |b| b["type"] == "object" }
        return { "type" => "object" }.merge(schema)
      end

      merged_props = {}
      required_counts = Hash.new(0)
      enum_candidate = Hash.new { |h, k| h[k] = [] }
      every_branch_has = Hash.new(0)

      branches.each do |branch|
        props = branch["properties"] || {}
        props.each do |key, prop|
          every_branch_has[key] += 1
          merged_props[key] = (merged_props[key] || {}).merge(prop)
          enum_candidate[key] << prop["const"] if prop.is_a?(Hash) && prop.key?("const")
        end
        (branch["required"] || []).each { |r| required_counts[r] += 1 }
      end

      enum_candidate.each do |key, values|
        next unless every_branch_has[key] == branches.length && values.uniq.length > 1

        rest = merged_props[key].reject { |k, _| k == "const" }
        merged_props[key] = rest.merge("enum" => values.uniq)
      end

      required = required_counts.select { |_, c| c == branches.length }.keys
      meta = schema.reject { |k, _| %w[oneOf anyOf allOf type properties required].include?(k) }

      out = meta.merge("type" => "object", "properties" => merged_props)
      out["required"] = required unless required.empty?
      out
    end

    # Collects DSL declarations into a root object JSON Schema.
    class Builder
      def initialize
        @properties = {}
        @required = []
      end

      SCALAR_TYPES.each_key do |kind|
        define_method(kind) do |name, required: false, description: nil, enum: nil, **extra|
          add(name, scalar(kind, description: description, enum: enum, **extra), required: required)
        end
      end

      # array :tags, items: :string  OR  array :rows, items: { ... nested ... }
      def array(name, items: nil, required: false, description: nil, **extra, &block)
        item_schema =
          if block
            nested = Builder.new
            nested.instance_eval(&block)
            nested.to_schema
          elsif items.is_a?(Symbol)
            { "type" => SCALAR_TYPES.fetch(items, items.to_s) }
          elsif items.is_a?(Hash)
            ToolSchema.stringify(items)
          end
        prop = { "type" => "array" }
        prop["description"] = description if description
        prop["items"] = item_schema if item_schema
        prop.merge!(ToolSchema.stringify(extra))
        add(name, prop, required: required)
      end

      # object :filter, required: true do ... end
      def object(name, required: false, description: nil, **extra, &block)
        nested = Builder.new
        nested.instance_eval(&block) if block
        prop = nested.to_schema
        prop["description"] = description if description
        prop.merge!(ToolSchema.stringify(extra))
        add(name, prop, required: required)
      end

      def to_schema
        schema = { "type" => "object", "properties" => @properties }
        schema["required"] = @required unless @required.empty?
        schema
      end

      private

      def scalar(kind, description: nil, enum: nil, **extra)
        prop = { "type" => SCALAR_TYPES.fetch(kind) }
        prop["description"] = description if description
        prop["enum"] = enum if enum
        prop.merge!(ToolSchema.stringify(extra))
        prop
      end

      def add(name, prop, required:)
        key = name.to_s
        @properties[key] = prop
        @required << key if required
      end
    end
  end
end
