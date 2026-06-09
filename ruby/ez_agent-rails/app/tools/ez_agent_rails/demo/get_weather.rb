# frozen_string_literal: true

module EZAgentRails
  module Demo
    # Example {EZAgent::Tool} shipped with the engine's demo so a run can call a
    # tool end-to-end with zero external setup. Like every ez_agent tool it is a
    # thin Ruby wrapper over code you already have — here a tiny in-memory lookup
    # standing in for a real weather service / HTTP call.
    #
    # Register it (and your own tools) in the initializer:
    #
    #   EZAgentRails.configure do |c|
    #     c.tools = [EZAgentRails::Demo::GetWeather]
    #   end
    class GetWeather < EZAgent::Tool
      tool_name "get_weather"
      description "Look up the current weather for a city (demo data, no network)."
      param :city, :string, required: true, description: "City name, e.g. 'Tokyo'"

      # Plain-Ruby data the tool wraps. A real tool would query a service object,
      # the DB, or an HTTP API here.
      FORECASTS = {
        "tokyo" => "18°C, clear skies",
        "paris" => "12°C, light rain",
        "london" => "11°C, overcast",
        "new york" => "9°C, windy",
        "san francisco" => "16°C, foggy",
        "sydney" => "24°C, sunny"
      }.freeze

      DEFAULT_FORECAST = "15°C, partly cloudy"

      def perform(city:)
        forecast = FORECASTS.fetch(city.to_s.strip.downcase, DEFAULT_FORECAST)
        "Weather in #{city}: #{forecast}."
      end
    end
  end
end
