; TeamClaude-Setup-<version>.exe: a per-user install that needs no
; administrator rights, no Node and no npm. It installs the bundled Node
; (renamed teamclaude-node.exe), the app, and TeamClaude.exe from
; launcher.nsi. The user's config and accounts live outside the install
; folder and are never touched, by install or uninstall.
;
; Built by scripts/build-windows-installer.mjs with -DVERSION, -DSTAGE and
; -DOUTFILE, after it has compiled the launcher into STAGE.

Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\TeamClaude"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "TeamClaude"
Caption "TeamClaude ${VERSION} Setup"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\TeamClaude"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
SetCompressor /SOLID lzma
ManifestDPIAware true

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "TeamClaude"
VIAddVersionKey "FileDescription" "TeamClaude Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "KarpelesLab"
VIAddVersionKey "LegalCopyright" "MIT License"

!define MUI_ICON "${STAGE}\teamclaude.ico"
!define MUI_UNICON "${STAGE}\teamclaude.ico"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TEXT "This installs TeamClaude ${VERSION}, which pools your own Claude, Codex and other accounts behind one local proxy.$\r$\n$\r$\nIt installs for your Windows account only and does not need administrator rights. When it finishes, the TeamClaude dashboard opens in your browser, where you sign in your accounts.$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\TeamClaude.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open TeamClaude"
!insertmacro MUI_PAGE_FINISH

!define MUI_UNCONFIRMPAGE_TEXT_TOP "TeamClaude will be stopped and removed from your computer.$\r$\n$\r$\nYour settings and signed-in accounts (the .config\teamclaude.json file in your user folder) are kept, so a later install picks them up again. Delete that file yourself to remove them."
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; An upgrade replaces node\ and app\, and a running proxy holds
; teamclaude-node.exe open. Only the bundled Node has that image name.
!macro StopProxy
  nsExec::Exec 'taskkill /F /IM teamclaude-node.exe'
  Pop $0
  ; taskkill returns before the process has let go of its files.
  Sleep 1000
!macroend

Section "TeamClaude" SecMain
  SectionIn RO
  !insertmacro StopProxy

  ; Cleared rather than overwritten, so a module a newer version dropped is
  ; not left behind to be imported.
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"

  SetOutPath "$INSTDIR"
  File "${STAGE}\TeamClaude.exe"
  File "${STAGE}\LICENSE.txt"
  SetOutPath "$INSTDIR\node"
  File "${STAGE}\node\teamclaude-node.exe"
  SetOutPath "$INSTDIR\app"
  File /r "${STAGE}\app\*.*"
  SetOutPath "$INSTDIR"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\TeamClaude"
  CreateShortcut "$SMPROGRAMS\TeamClaude\TeamClaude.lnk" "$INSTDIR\TeamClaude.exe"
  CreateShortcut "$SMPROGRAMS\TeamClaude\Stop TeamClaude.lnk" "$INSTDIR\TeamClaude.exe" "--stop"
  CreateShortcut "$SMPROGRAMS\TeamClaude\Uninstall TeamClaude.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "TeamClaude"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "KarpelesLab"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "https://github.com/KarpelesLab/teamclaude"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\TeamClaude.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" $0

  ; The next section writes it back when it is ticked, so a reinstall with
  ; the box cleared turns starting at sign-in off.
  DeleteRegValue HKCU "${RUN_KEY}" "TeamClaude"
SectionEnd

Section "Start TeamClaude when I sign in" SecRun
  WriteRegStr HKCU "${RUN_KEY}" "TeamClaude" '"$INSTDIR\TeamClaude.exe" --no-open'
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "The TeamClaude proxy and the Node runtime it runs on."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecRun} "Start the proxy in the background whenever you sign in to Windows, so your tools can reach it without opening TeamClaude first."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  !insertmacro StopProxy
  DeleteRegValue HKCU "${RUN_KEY}" "TeamClaude"
  RMDir /r "$SMPROGRAMS\TeamClaude"

  ; Only what the installer put here: the folder may be one the user chose
  ; and keeps other things in.
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"
  Delete "$INSTDIR\TeamClaude.exe"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  ; The proxy's log, written by `teamclaude desktop`. The config is elsewhere
  ; and stays.
  Delete "$LOCALAPPDATA\TeamClaude\teamclaude.log"
  RMDir "$LOCALAPPDATA\TeamClaude"

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
