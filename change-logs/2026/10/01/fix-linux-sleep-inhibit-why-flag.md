Short: Sleep prevention works on Linux

Sleep prevention on Linux now passes `--why=` to `systemd-inhibit`, which rejected the old `--reason=` flag, so the inhibit process exited at once and was respawned every 10 seconds. An inhibit process that is refused outright (for example by polkit under WSL) now counts toward the existing three-strikes limit instead of retrying forever.
