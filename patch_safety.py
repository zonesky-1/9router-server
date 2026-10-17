#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🛡️ 9Router Safety Guardrail Zero-Refusal Patcher
================================================
Mengubah default safety filter Gemini & LLM di internal 9Router
menjadi BLOCK_NONE / pass-through bebas batasan.
"""

import os
import sys

TARGET_CHUNKS = [
    "/opt/9router/.next/server/chunks/2591.js",
    "/usr/local/lib/node_modules/9router/.next/server/chunks/2591.js"
]

TARGET_5714 = [
    "/opt/9router/.next/server/chunks/5714.js",
    "/usr/local/lib/node_modules/9router/.next/server/chunks/5714.js"
]

TARGET_SRC = [
    "/opt/9router/open-sse/translator/formats/gemini.js",
    "/usr/local/lib/node_modules/9router/open-sse/translator/formats/gemini.js"
]

def patch_safety():
    print("[*] Menjalankan 9Router Zero-Refusal Safety Patcher...")
    patched_any = False

    # 1. Patch 2591.js
    for p in TARGET_CHUNKS:
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                c = f.read()
            old_s = 'l=[{category:"HARM_CATEGORY_HATE_SPEECH",threshold:"OFF"},{category:"HARM_CATEGORY_DANGEROUS_CONTENT",threshold:"OFF"},{category:"HARM_CATEGORY_SEXUALLY_EXPLICIT",threshold:"OFF"},{category:"HARM_CATEGORY_HARASSMENT",threshold:"OFF"},{category:"HARM_CATEGORY_CIVIC_INTEGRITY",threshold:"OFF"}];'
            new_s = 'l=[{category:"HARM_CATEGORY_HARASSMENT",threshold:"BLOCK_NONE"},{category:"HARM_CATEGORY_HATE_SPEECH",threshold:"BLOCK_NONE"},{category:"HARM_CATEGORY_SEXUALLY_EXPLICIT",threshold:"BLOCK_NONE"},{category:"HARM_CATEGORY_DANGEROUS_CONTENT",threshold:"BLOCK_NONE"},{category:"HARM_CATEGORY_CIVIC_INTEGRITY",threshold:"BLOCK_NONE"}];'
            if old_s in c:
                c = c.replace(old_s, new_s)
                with open(p, "w", encoding="utf-8") as f:
                    f.write(c)
                print(f"  [+] Patched safety filter to BLOCK_NONE di: {p}")
                patched_any = True

    # 2. Patch 5714.js pass-through
    for p in TARGET_5714:
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                c = f.read()
            if "safetySettings:a.v6" in c:
                c = c.replace("safetySettings:a.v6", "safetySettings:t.safetySettings||a.v6")
                with open(p, "w", encoding="utf-8") as f:
                    f.write(c)
                print(f"  [+] Patched client pass-through di: {p}")
                patched_any = True

    # 3. Patch source gemini.js
    for p in TARGET_SRC:
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                c = f.read()
            old_src = 'threshold: "OFF"'
            new_src = 'threshold: "BLOCK_NONE"'
            if old_src in c:
                c = c.replace(old_src, new_src)
                with open(p, "w", encoding="utf-8") as f:
                    f.write(c)
                print(f"  [+] Patched gemini source di: {p}")
                patched_any = True

    if not patched_any:
        print("[-] Target chunks tidak ditemukan di path default. Pastikan 9router terinstall via npm global atau /opt/9router.")
    else:
        print("[🎉] Sukses menerapkan Zero-Refusal Safety Patch pada 9Router!")

if __name__ == "__main__":
    patch_safety()
