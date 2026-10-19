; myCarlos's hooks into the Windows installer (Tauri NSIS, tauri.conf.json).
;
; The PDF helper runs in an AppContainer (#63, src-tauri/src/pdf_unlock.rs), which can start
; only a program that ALL APPLICATION PACKAGES (S-1-15-2-1) may read and run. Program Files
; allows that already; a per-user install folder does not. So the install folder allows it:
; read and run only, inherited by the files in it. Nothing in the folder is private: the
; vault is kept elsewhere.
!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX) /C /Q'
  Pop $0
!macroend

; The helper's AppContainer profile, made the first time the helper runs, goes with myCarlos.
!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'userenv::DeleteAppContainerProfile(w "mycarlos.pdfhelper") i .r0'
!macroend
