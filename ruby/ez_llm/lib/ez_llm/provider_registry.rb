# frozen_string_literal: true

module EZLLM
  # Map-based provider registry. Built-in providers register at load time (see
  # the `register_builtin_providers!` call at the bottom of ez_llm.rb's provider
  # wiring); consumers can register custom providers at runtime.
  #
  # An entry is any callable `->(request, &on_event) { ...; EZLLM::Response }`.
  # Port of provider-registry.ts.
  module ProviderRegistry
    @providers = {}
    @mutex = Mutex.new

    class << self
      # Register (or overwrite) a provider. The entry must respond to #call.
      def register(name, entry = nil, &block)
        callable = entry || block
        raise ArgumentError, "provider entry must be callable" unless callable.respond_to?(:call)

        @mutex.synchronize { @providers[name.to_sym] = callable }
      end

      def unregister(name)
        @mutex.synchronize { !@providers.delete(name.to_sym).nil? }
      end

      def get(name)
        @mutex.synchronize { @providers[name.to_sym] }
      end

      def has?(name)
        @mutex.synchronize { @providers.key?(name.to_sym) }
      end

      def list
        @mutex.synchronize { @providers.keys }
      end
    end
  end
end
