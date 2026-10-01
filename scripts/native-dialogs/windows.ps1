param([Parameter(Mandatory)][int]$AppPid, [Parameter(Mandatory)][string]$Title,
      [Parameter(Mandatory)][string]$Action, [string]$Value = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public static class NativeDialogInput {
  public class WindowInfo { public long hwnd,owner; public uint pid,ownerPid; public string title,windowClass; }
  delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  public static WindowInfo[] Windows(uint appPid) {
    var result = new List<WindowInfo>();
    EnumWindowProc callback = (window, parameter) => {
      uint pid; GetWindowThreadProcessId(window, out pid);
      if (pid != appPid || !IsWindowVisible(window)) return true;
      var title = new StringBuilder(1024); GetWindowText(window, title, title.Capacity);
      var name = new StringBuilder(256); GetClassName(window, name, name.Capacity);
      var owner = GetWindow(window, 4); // GW_OWNER
      uint ownerPid = 0; if (owner != IntPtr.Zero) GetWindowThreadProcessId(owner, out ownerPid);
      result.Add(new WindowInfo { hwnd=window.ToInt64(), owner=owner.ToInt64(), pid=pid, ownerPid=ownerPid, title=title.ToString(), windowClass=name.ToString() });
      return true;
    };
    if (!EnumWindows(callback, IntPtr.Zero)) throw new Exception("EnumWindows failed: " + Marshal.GetLastWin32Error());
    return result.ToArray();
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static void Key(IntPtr window, uint pid, ushort key) {
    uint actual; GetWindowThreadProcessId(window, out actual);
    if (actual != pid || GetForegroundWindow() != window) throw new Exception("Dialog lost foreground or ownership before keypress");
    var inputs = new INPUT[2];
    inputs[0].type=inputs[1].type=1;
    inputs[0].data.keyboard.key=inputs[1].data.keyboard.key=key;
    inputs[1].data.keyboard.flags=2;
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
  }
}
'@
$UI = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
# Owned modal windows need not appear directly under the UIA desktop root.
# Find the real top-level HWND first, then obtain its accessibility element.
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$dialog = $null
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
    $hwnd = [IntPtr]$nativeWindow.hwnd
    $dialog = $UI::FromHandle($hwnd)
    break
  }
  Start-Sleep -Milliseconds 100
}
if ($null -eq $dialog) {
  $diagnostic = @($windows | ForEach-Object {
    $info = @{nativeWindow=$_}
    try {
      $accessible = $UI::FromHandle([IntPtr]$_.hwnd)
      $info.uiaName = $accessible.Current.Name
      $info.uiaType = $accessible.Current.ControlType.ProgrammaticName
    } catch { $info.uiaError = $_.Exception.Message }
    $info
  }) | ConvertTo-Json -Compress -Depth 4
  throw "Native dialog not found: $Title; visible app windows: $diagnostic"
}
[uint32]$ownerPid = 0
[void][NativeDialogInput]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
if ($ownerPid -ne $AppPid) { throw 'Wrong native dialog owner' }
$buttonCondition = [System.Windows.Automation.PropertyCondition]::new($UI::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$buttons = $dialog.FindAll($scope::Descendants, $buttonCondition)
$beforeFocus = $UI::FocusedElement.Current.Name
# Activate only the dialog window; never move focus to a particular button.
[void][NativeDialogInput]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 100
if ([NativeDialogInput]::GetForegroundWindow() -ne $hwnd) { throw 'Could not foreground the owned dialog' }
$focusDeadline = [DateTime]::UtcNow.AddSeconds(5)
$focusOwned = $false
while ([DateTime]::UtcNow -lt $focusDeadline) {
  $focus = $UI::FocusedElement
  $ancestor = $focus
  while ($null -ne $ancestor) {
    if ([System.Windows.Automation.Automation]::Compare($ancestor, $dialog)) { $focusOwned = $true; break }
    $ancestor = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($ancestor)
  }
  if ($focusOwned) { break }
  Start-Sleep -Milliseconds 50
}
if (!$focusOwned) { throw 'Keyboard focus is outside the owned dialog' }
$evidence = @{nativeWindow=$nativeWindow; title=$dialog.Current.Name; action=$Action; buttons=@($buttons | ForEach-Object { $_.Current.Name }); beforeActivationFocus=$beforeFocus; focus=$focus.Current.Name; focusType=$focus.Current.ControlType.ProgrammaticName}
switch ($Action) {
  'enter' { [NativeDialogInput]::Key($hwnd, $AppPid, 0x0D) }
  'space' { [NativeDialogInput]::Key($hwnd, $AppPid, 0x20) }
  'escape' { [NativeDialogInput]::Key($hwnd, $AppPid, 0x1B) }
  'close' { if (![NativeDialogInput]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'WM_CLOSE failed' } }
  'button' {
    $matching = @($buttons | Where-Object { $_.Current.Name -eq $Value })
    if ($matching.Count -ne 1) { throw "Expected one button named $Value; found $($matching.Count)" }
    ([System.Windows.Automation.InvokePattern]$matching[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
  }
  'file' {
    $editCondition = [System.Windows.Automation.PropertyCondition]::new($UI::AutomationIdProperty, '1001')
    $edit = $dialog.FindFirst($scope::Descendants, $editCondition)
    if ($null -eq $edit) { throw 'File name edit was not found' }
    ([System.Windows.Automation.ValuePattern]$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($Value)
    $label = if ($Title -eq 'FILE_SAVE') { 'Save' } else { 'Open' }
    $matching = @($buttons | Where-Object { $_.Current.Name.Replace('&','') -eq $label })
    if ($matching.Count -ne 1) { throw "Expected one file picker $label button" }
    ([System.Windows.Automation.InvokePattern]$matching[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
  }
  default { throw "Unknown native action: $Action" }
}
$evidence | ConvertTo-Json -Compress -Depth 5
