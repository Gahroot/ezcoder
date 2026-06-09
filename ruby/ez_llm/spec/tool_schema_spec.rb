# frozen_string_literal: true

RSpec.describe EZLLM::ToolSchema do
  it "compiles scalars, enums, required, arrays, and nested objects" do
    schema = described_class.build do
      string :city, required: true, description: "City to look up"
      integer :days
      string :units, enum: %w[metric imperial]
      array :tags, items: :string
      object :filter do
        boolean :open_now
      end
    end.to_json_schema

    expect(schema["type"]).to eq("object")
    expect(schema["required"]).to eq(["city"])
    expect(schema.dig("properties", "city")).to eq("type" => "string", "description" => "City to look up")
    expect(schema.dig("properties", "units", "enum")).to eq(%w[metric imperial])
    expect(schema.dig("properties", "tags")).to eq("type" => "array", "items" => { "type" => "string" })
    expect(schema.dig("properties", "filter", "type")).to eq("object")
    expect(schema.dig("properties", "filter", "properties", "open_now", "type")).to eq("boolean")
  end

  it "produces a valid root object even with no params" do
    expect(described_class.build.to_json_schema).to eq("type" => "object", "properties" => {})
  end

  describe "Anthropic root normalization" do
    it "flattens a root oneOf union into one object with a discriminator enum" do
      raw = {
        "oneOf" => [
          { "type" => "object",
            "properties" => { "action" => { "const" => "create" }, "name" => { "type" => "string" } },
            "required" => %w[action name] },
          { "type" => "object",
            "properties" => { "action" => { "const" => "delete" }, "id" => { "type" => "string" } },
            "required" => %w[action id] }
        ]
      }
      out = described_class.raw(raw).to_json_schema
      expect(out["type"]).to eq("object")
      expect(out).not_to have_key("oneOf")
      expect(out.dig("properties", "action", "enum")).to match_array(%w[create delete])
      # required is the intersection — only `action` is required in every branch
      expect(out["required"]).to eq(["action"])
    end
  end

  describe "#validate" do
    let(:schema) do
      described_class.build do
        string :city, required: true
        integer :days
      end
    end

    it "flags missing required fields and type mismatches" do
      _, errors = schema.validate({ "days" => "soon" })
      expect(errors).to include(a_string_matching(/city.*required/))
      expect(errors).to include(a_string_matching(/days.*expected integer/))
    end

    it "passes valid args" do
      args, errors = schema.validate({ city: "Tokyo", days: 3 })
      expect(errors).to be_empty
      expect(args).to eq("city" => "Tokyo", "days" => 3)
    end
  end
end
