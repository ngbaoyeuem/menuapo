# -*- coding: utf-8 -*-
# 1-Click Automated IPA Patcher for APO Crusher
# Injects ApoCrusher.dylib into ANY iOS App (Discord, Messenger, Telegram, Zalo, Games, etc.)
# by Nguyen Hoang Gia Bao

import os, sys, shutil, zipfile, struct

def patch_macho_binary(macho_path, dylib_to_inject="@rpath/ApoCrusher.dylib"):
    with open(macho_path, "rb") as f:
        data = bytearray(f.read())
        
    if len(data) < 32:
        return False
        
    magic = struct.unpack("<I", data[:4])[0]
    if magic != 0xFEEDFACF: # MH_MAGIC_64
        return False
        
    cputype, cpusubtype, filetype, ncmds, sizeofcmds, flags = struct.unpack("<IIIIII", data[4:28])
    
    # Prepare LC_LOAD_DYLIB command
    path_bytes = dylib_to_inject.encode("utf-8") + b"\x00"
    cmdsize = 24 + len(path_bytes)
    if cmdsize % 8 != 0: cmdsize += (8 - cmdsize % 8)
    
    lc_load_dylib = struct.pack("<IIIIII", 0xC, cmdsize, 24, 0, 0, 0) + path_bytes
    if len(lc_load_dylib) < cmdsize:
        lc_load_dylib += b"\x00" * (cmdsize - len(lc_load_dylib))
        
    # Check if header has enough padding
    offset_cmds = 32
    end_of_cmds = offset_cmds + sizeofcmds
    
    # Append LC_LOAD_DYLIB
    data[end_of_cmds:end_of_cmds+len(lc_load_dylib)] = lc_load_dylib
    
    # Update Header
    struct.pack_into("<II", data, 16, ncmds + 1, sizeofcmds + cmdsize)
    
    with open(macho_path, "wb") as f:
        f.write(data)
    return True

def patch_ipa(input_ipa, dylib_path, output_ipa):
    print(f"[+] Processing IPA: {input_ipa}")
    temp_dir = "temp_patch_payload"
    if os.path.exists(temp_dir): shutil.rmtree(temp_dir)
    os.makedirs(temp_dir, exist_ok=True)
    
    with zipfile.ZipFile(input_ipa, "r") as z:
        z.extractall(temp_dir)
        
    payload_dir = os.path.join(temp_dir, "Payload")
    app_folder = None
    for item in os.listdir(payload_dir):
        if item.endswith(".app"):
            app_folder = os.path.join(payload_dir, item)
            break
            
    if not app_folder:
        print("[-] Error: No .app found in Payload!")
        return False
        
    app_name = os.path.splitext(os.path.basename(app_folder))[0]
    macho_exec = os.path.join(app_folder, app_name)
    
    # Copy ApoCrusher.dylib into .app
    shutil.copy(dylib_path, os.path.join(app_folder, "ApoCrusher.dylib"))
    
    # Patch executable
    if os.path.exists(macho_exec):
        patch_macho_binary(macho_exec, "@rpath/ApoCrusher.dylib")
        print(f"[+] Injected ApoCrusher.dylib into binary: {app_name}")
        
    # Repackage IPA
    with zipfile.ZipFile(output_ipa, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(temp_dir):
            for f in files:
                full_p = os.path.join(root, f)
                rel_p = os.path.relpath(full_p, temp_dir)
                z.write(full_p, rel_p)
                
    shutil.rmtree(temp_dir)
    print(f"[✓] SUCCESS! Patched IPA created: {output_ipa}")
    return True

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Huong dan su dung:")
        print("  python auto_patch_ipa.py <DuongDanFile.ipa>")
        print("Vi du:")
        print("  python auto_patch_ipa.py Discord.ipa")
        print("  python auto_patch_ipa.py Messenger.ipa")
    else:
        in_ipa = sys.argv[1]
        out_ipa = in_ipa.replace(".ipa", "_APO_Patched.ipa")
        dylib = os.path.join(os.path.dirname(__file__), "ApoCrusher.dylib")
        if not os.path.exists(dylib):
            dylib = os.path.join(os.path.dirname(__file__), "..", "dist", "ApoCrusher.dylib")
        patch_ipa(in_ipa, dylib, out_ipa)
