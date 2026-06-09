# frozen_string_literal: true

# A confirmation-gated tool for the human-in-the-loop specs. It opts into the
# approval gate via `requires_confirmation!` and records every ACTUAL execution
# so a spec can prove the tool ran (approved) or did not (denied / aborted /
# timed out). Executions are tracked in a thread-safe Queue because the RunJob
# runs in a different thread than the spec that resolves the confirmation.
class SpecGatedTool < EZAgent::Tool
  tool_name "danger_write"
  description "Writes a file. Gated behind human approval in specs."
  requires_confirmation!
  param :path, :string, description: "Destination path"

  EXECUTIONS = Thread::Queue.new

  class << self
    def reset!
      EXECUTIONS.clear
    end

    def execution_count
      EXECUTIONS.size
    end

    def executed_paths
      paths = []
      paths << EXECUTIONS.pop(true) until EXECUTIONS.empty?
      paths
    rescue ThreadError
      paths
    end
  end

  def perform(path: "unset")
    EXECUTIONS << path
    "wrote #{path}"
  end
end
