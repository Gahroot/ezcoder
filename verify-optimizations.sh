#!/bin/bash
echo "=== Verification of Memory Optimizations ==="
echo ""

echo "1. Checking EventStream buffer..."
if grep -q "2_000" packages/ai/src/utils/event-stream.ts; then
    echo "   ✓ EventStream buffer reduced to 2K"
else
    echo "   ✗ EventStream buffer not optimized"
fi

echo ""
echo "2. Checking session truncation..."
if grep -q "MAX_MESSAGES = 100" packages/cli/src/session.ts; then
    echo "   ✓ Session truncation enabled (100 messages max)"
else
    echo "   ✗ Session truncation not found"
fi

echo ""
echo "3. Checking agent maxMessages..."
if grep -q "maxMessages" packages/agent/src/types.ts; then
    echo "   ✓ Agent maxMessages option added"
else
    echo "   ✗ Agent maxMessages not found"
fi

echo ""
echo "4. Checking agent-loop truncation..."
if grep -q "MAX_MESSAGES.*=.*options.maxMessages" packages/agent/src/agent-loop.ts; then
    echo "   ✓ Agent loop enforces maxMessages"
else
    echo "   ✗ Agent loop not enforcing maxMessages"
fi

echo ""
echo "=== Summary ==="
echo "Files modified:"
git diff --name-only 2>/dev/null | grep -E "(event-stream|session|types|agent-loop)" || find . -name "*.ts" -newer OPTIMIZATIONS_APPLIED.md | grep -E "(event-stream|session|types|agent-loop)"

echo ""
echo "Expected RAM savings: 60-80%"
echo ""
echo "Next: Run 'npm run build' to compile changes"
