param([Parameter(Mandatory)][int]$AppPid, [Parameter(Mandatory)][string]$Title,
      [Parameter(Mandatory)][string]$Action, [string]$Value = '')
$ErrorActionPreference = 'Stop'
# Win32 identifies the actual controls independently of UIA client-side proxies.
# Every keyboard action targets an owned foreground dialog with verified focus.
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
using System.Threading;
public static class NativeDialogInput {
  public class WindowInfo { public long hwnd,owner; public uint pid,ownerPid; public int id; public string title,windowClass; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUIINFO {
    public uint size,flags;
    public IntPtr active,focus,capture,menuOwner,moveSize,caret;
    public RECT caretRect;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetGUIThreadInfo(uint thread, ref GUIINFO info);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr ReadMessage(IntPtr hwnd, uint msg, UIntPtr w, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr ScalarMessage(IntPtr hwnd, uint msg, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
  static string ClassName(IntPtr window) {
    var text = new StringBuilder(256); GetClassName(window, text, text.Capacity); return text.ToString();
  }
  static string ControlText(IntPtr window) {
    var text = new StringBuilder(4096); UIntPtr result;
    // WM_GETTEXT; finite timeout, abort if hung or the target disappears.
    if (ReadMessage(window, 0x000D, (UIntPtr)text.Capacity, text, 0x22, 1000, out result) == IntPtr.Zero)
      throw new Exception("Control text read failed or timed out");
    if (result.ToUInt64() >= (ulong)text.Capacity - 1) throw new Exception("Control text truncated");
    return text.ToString();
  }
  public static WindowInfo[] Windows(uint appPid) {
    var result = new List<WindowInfo>();
    EnumWindowProc callback = (window, parameter) => {
      uint pid; GetWindowThreadProcessId(window, out pid);
      if (pid != appPid || !IsWindowVisible(window)) return true;
      var title = new StringBuilder(1024); GetWindowText(window, title, title.Capacity);
      var owner = GetWindow(window, 4); // GW_OWNER
      uint ownerPid = 0; if (owner != IntPtr.Zero) GetWindowThreadProcessId(owner, out ownerPid);
      result.Add(new WindowInfo { hwnd=window.ToInt64(), owner=owner.ToInt64(), pid=pid, ownerPid=ownerPid, title=title.ToString(), windowClass=ClassName(window) });
      return true;
    };
    if (!EnumWindows(callback, IntPtr.Zero)) throw new Exception("EnumWindows failed: " + Marshal.GetLastWin32Error());
    return result.ToArray();
  }
  static void OwnedChild(IntPtr dialog, uint pid, IntPtr child) {
    uint actual; GetWindowThreadProcessId(child, out actual);
    if (actual != pid || !IsChild(dialog, child) || !IsWindowVisible(child) || !IsWindowEnabled(child))
      throw new Exception("Control focus/ownership is not ready: hwnd=" + child.ToInt64() + ", pid=" + actual + ", class=" + ClassName(child) + ", child=" + IsChild(dialog,child) + ", visible=" + IsWindowVisible(child) + ", enabled=" + IsWindowEnabled(child));
  }
  public static WindowInfo[] Controls(IntPtr dialog, uint pid) {
    var result = new List<WindowInfo>();
    // Never allow a managed exception to unwind through an unmanaged callback.
    Exception failure = null;
    EnumWindowProc callback = (window, parameter) => {
      try {
        string name = ClassName(window);
        if (name != "Button" && name != "Edit" && name != "Static") return true;
        if (!IsWindowVisible(window) || !IsWindowEnabled(window)) return true;
        OwnedChild(dialog, pid, window);
        result.Add(new WindowInfo { hwnd=window.ToInt64(), pid=pid, id=GetDlgCtrlID(window), title=ControlText(window), windowClass=name });
        return true;
      } catch (Exception error) { failure=error; return false; }
    };
    // This enumerates descendants; its return value is documented as unused.
    EnumChildWindows(dialog, callback, IntPtr.Zero);
    if (failure != null) throw failure;
    return result.ToArray();
  }
  public static IntPtr Focus(IntPtr dialog, uint pid) {
    uint actual; uint thread=GetWindowThreadProcessId(dialog, out actual);
    if (actual != pid || GetForegroundWindow() != dialog) throw new Exception("Dialog lost foreground or ownership");
    var info = new GUIINFO { size=(uint)Marshal.SizeOf(typeof(GUIINFO)) };
    if (!GetGUIThreadInfo(thread, ref info)) throw new Exception("GetGUIThreadInfo failed");
    if (info.focus != dialog) {
      try { OwnedChild(dialog, pid, info.focus); }
      catch (Exception error) {
        throw new Exception("Dialog=" + dialog.ToInt64() + ", expectedPid=" + pid + ", thread=" + thread + ", active=" + info.active.ToInt64() + ", flags=" + info.flags + "; " + error.Message);
      }
    }
    return info.focus;
  }
  public static WindowInfo FocusInfo(IntPtr dialog, uint pid) {
    var focus=Focus(dialog,pid);
    return new WindowInfo { hwnd=focus.ToInt64(), pid=pid, title=ControlText(focus), windowClass=ClassName(focus) };
  }
  public static void Key(IntPtr dialog, uint pid, ushort key) { Key(dialog,pid,key,IntPtr.Zero); }
  static void Key(IntPtr dialog, uint pid, ushort key, IntPtr expectedFocus) {
    var focus=Focus(dialog,pid); // Recheck immediately before every real keypress.
    if (expectedFocus != IntPtr.Zero && focus != expectedFocus) throw new Exception("Target button lost focus before activation");
    var inputs = new INPUT[2];
    inputs[0].type=inputs[1].type=1;
    inputs[0].data.keyboard.key=inputs[1].data.keyboard.key=key;
    inputs[1].data.keyboard.flags=2;
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
  }
  public static int Activate(IntPtr dialog, uint pid, IntPtr button, string label) {
    // Explicit actions only. Never called for untouched initial Enter/Space.
    for (int tabs=0; tabs<=50; tabs++) {
      OwnedChild(dialog,pid,button);
      if (ClassName(button) != "Button" || ControlText(button) != label) throw new Exception("Button identity changed");
      if (Focus(dialog,pid) == button) {
        Key(dialog,pid,0x20,button);
        return tabs;
      }
      if (tabs < 50) { Key(dialog,pid,0x09); Thread.Sleep(100); }
    }
    throw new Exception("Tab did not reach the exact requested button");
  }
  static void FilenameIdentity(IntPtr dialog, uint pid, IntPtr edit, int expectedId) {
    OwnedChild(dialog,pid,edit);
    if ((expectedId != 1001 && expectedId != 1148) || ClassName(edit) != "Edit" || GetDlgCtrlID(edit) != expectedId)
      throw new Exception("Wrong filename control");
  }
  public static int Filename(IntPtr dialog, uint pid, IntPtr edit, int expectedId, string text) {
    int tabs=0;
    for (; tabs<=50; tabs++) {
      FilenameIdentity(dialog,pid,edit,expectedId);
      if (Focus(dialog,pid) == edit) break;
      if (tabs < 50) { Key(dialog,pid,0x09); Thread.Sleep(100); }
    }
    if (tabs > 50) throw new Exception("Tab did not reach the filename control");
    FilenameIdentity(dialog,pid,edit,expectedId);
    if (Focus(dialog,pid) != edit) throw new Exception("Filename control lost focus");
    UIntPtr result;
    // EM_SETSEL selects the existing filename; genuine Unicode input replaces it.
    // WM_SETTEXT readback alone does not prove the picker accepted a new filename.
    if (ScalarMessage(edit, 0x00B1, UIntPtr.Zero, new IntPtr(-1), 0x22, 1000, out result) == IntPtr.Zero)
      throw new Exception("Filename selection failed or timed out");
    foreach (char character in text) {
      FilenameIdentity(dialog,pid,edit,expectedId);
      if (Focus(dialog,pid) != edit) throw new Exception("Filename control lost focus while typing");
      var inputs = new INPUT[2];
      inputs[0].type=inputs[1].type=1;
      inputs[0].data.keyboard.scan=inputs[1].data.keyboard.scan=character;
      inputs[0].data.keyboard.flags=4; // KEYEVENTF_UNICODE; wVk stays zero.
      inputs[1].data.keyboard.flags=6; // UNICODE | KEYUP.
      if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new Exception("Filename input failed");
    }
    // SendInput queues input. Wait for the target thread to consume it.
    for (int i=0; i<20; i++) {
      FilenameIdentity(dialog,pid,edit,expectedId);
      if (Focus(dialog,pid) != edit) throw new Exception("Filename control lost focus before readback");
      if (ControlText(edit) == text) return tabs;
      Thread.Sleep(100);
    }
    throw new Exception("Filename readback differs");
  }
}
'@
if ($Action -eq 'inspect') {
  # Failure evidence only: inspect the launched app's windows without input.
  @([NativeDialogInput]::Windows($AppPid) | ForEach-Object {
    $window = $_
    try { $children = @([NativeDialogInput]::Controls([IntPtr]$window.hwnd, $AppPid)) }
    catch { $children = @{error=$_.Exception.Message} }
    @{window=$window; controls=$children}
  }) | ConvertTo-Json -Compress -Depth 6
  exit
}
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$nativeWindow = $null
$windows = @()
while ([DateTime]::UtcNow -lt $deadline) {
  $windows = @([NativeDialogInput]::Windows($AppPid))
  $caption = if ($Title -eq 'FILE_SAVE') { 'Save As' } elseif ($Title -eq 'FILE_OPEN') { 'Open' } else { $Title }
  $matchingWindows = @($windows | Where-Object { $_.title -ceq $caption })
  if ($matchingWindows.Count -gt 1) { throw "Ambiguous native dialog: $caption" }
  if ($matchingWindows.Count -eq 1) {
    $nativeWindow = $matchingWindows[0]
    if (!$Title.StartsWith('FILE_') -and ($nativeWindow.owner -eq 0 -or $nativeWindow.ownerPid -ne $AppPid)) {
      throw 'Confirmation is not owned by the app window'
    }
    break
  }
  Start-Sleep -Milliseconds 100
}
if ($null -eq $nativeWindow) {
  $diagnostic = $windows | ConvertTo-Json -Compress -Depth 3
  throw "Native dialog not found: $Title; visible app windows: $diagnostic"
}
$hwnd = [IntPtr]$nativeWindow.hwnd
# Activate only the window, preserving the dialog's own initial button focus.
[void][NativeDialogInput]::SetForegroundWindow($hwnd)
# Wait for valid focus after the native window becomes visible, without
# changing which control the dialog chooses.
$focusDeadline = [DateTime]::UtcNow.AddSeconds(5)
$focus = $null
$focusError = ''
do {
  try { $focus = [NativeDialogInput]::FocusInfo($hwnd, $AppPid) }
  catch { $focusError = $_.Exception.Message }
  if ($null -ne $focus) { break }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $focusDeadline)
if ($null -eq $focus) { throw "Dialog focus did not become ready: $focusError" }
$controls = @([NativeDialogInput]::Controls($hwnd, $AppPid))
$buttons = @($controls | Where-Object { $_.windowClass -eq 'Button' })
$evidence = @{nativeWindow=$nativeWindow; title=$nativeWindow.title; action=$Action; buttons=@($buttons | ForEach-Object { $_.title }); focus=$focus.title; focusClass=$focus.windowClass; focusHwnd=$focus.hwnd}
function Activate-Button([string]$Label, [bool]$FilePicker = $false) {
  # Setting a filename can enable the file picker's Open/Save button.
  # Refresh controls after that change instead of reusing initial enabled state.
  $buttonDeadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $currentControls = @([NativeDialogInput]::Controls($hwnd, $AppPid))
    $matching = @($currentControls | Where-Object {
      $buttonLabel = if ($FilePicker) { $_.title.Replace('&','') } else { $_.title }
      $_.windowClass -eq 'Button' -and $buttonLabel -ceq $Label
    })
    if ($matching.Count -ne 0) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $buttonDeadline)
  if ($matching.Count -ne 1) {
    $diagnostic = $currentControls | ConvertTo-Json -Compress -Depth 3
    throw "Expected one button named $Label; found $($matching.Count); controls: $diagnostic"
  }
  $button = $matching[0]
  $evidence.tabs = [NativeDialogInput]::Activate($hwnd, $AppPid, [IntPtr]$button.hwnd, $button.title)
  $evidence.activated = $button.title
}
switch ($Action) {
  'enter' { [NativeDialogInput]::Key($hwnd, $AppPid, 0x0D) }
  'space' { [NativeDialogInput]::Key($hwnd, $AppPid, 0x20) }
  'escape' { [NativeDialogInput]::Key($hwnd, $AppPid, 0x1B) }
  'close' {
    [void][NativeDialogInput]::Focus($hwnd, $AppPid)
    if (![NativeDialogInput]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'WM_CLOSE failed' }
  }
  'button' { Activate-Button $Value }
  'file' {
    # Observed filename Edit IDs in the installed app's Save/Open pickers.
    # These are native implementation details, so reject unknown/ambiguous layouts.
    $edits = @($controls | Where-Object { $_.windowClass -eq 'Edit' -and $_.id -in @(1001,1148) })
    if ($edits.Count -ne 1) {
      $diagnostic = $controls | ConvertTo-Json -Compress -Depth 3
      throw "Expected one filename Edit1001/1148; controls: $diagnostic"
    }
    $evidence.filenameControlId = $edits[0].id
    $evidence.filenameTabs = [NativeDialogInput]::Filename($hwnd, $AppPid, [IntPtr]$edits[0].hwnd, $edits[0].id, $Value)
    $label = if ($Title -eq 'FILE_SAVE') { 'Save' } else { 'Open' }
    Activate-Button $label $true
  }
  default { throw "Unknown native action: $Action" }
}
$evidence | ConvertTo-Json -Compress -Depth 5
