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

; The helpers' AppContainer profiles, each made the first time its helper runs, go with myCarlos:
; the PDF helper's and the AI helper's model process's (#72, src-tauri/src/model_helper.rs).
!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'userenv::DeleteAppContainerProfile(w "mycarlos.pdfhelper") i .r0'
  System::Call 'userenv::DeleteAppContainerProfile(w "mycarlos.modelhelper") i .r0'
!macroend
