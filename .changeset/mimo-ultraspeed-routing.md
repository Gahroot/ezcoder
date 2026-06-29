---
"@prestyj/ai": patch
"@prestyj/core": patch
---

Add Xiaomi MiMo-V2.5-Pro UltraSpeed (`mimo-v2.5-pro-ultraspeed`). The model is
served only from the standard MiMo platform host (`api.xiaomimimo.com/v1`), not
the Token Plan subscription host, so the Xiaomi provider now routes that model
id to the platform endpoint (a stored Token-Plan baseUrl is overridden, while an
explicit custom baseUrl still wins). Fixes the "Not supported model" error when
selecting UltraSpeed.
