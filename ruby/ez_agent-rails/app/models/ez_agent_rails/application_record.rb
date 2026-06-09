# frozen_string_literal: true

module EZAgentRails
  # Abstract base so all engine models share one connection/abstract class and
  # stay namespaced (table prefix `ez_agent_rails_`).
  class ApplicationRecord < ActiveRecord::Base
    self.abstract_class = true
  end
end
