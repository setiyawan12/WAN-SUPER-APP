#!/bin/sh
set -eu

umask 077
cat /run/fixture/id_ed25519.pub > /home/wan/.ssh/authorized_keys
chmod 600 /home/wan/.ssh/authorized_keys
chown wan:wan /home/wan/.ssh/authorized_keys
password_hash="$(cat /run/fixture/password.hash)"
usermod -p "$password_hash" wan
unset password_hash
printf '%s\n' 'WAN SSH TEST FIXTURE - DO NOT USE OUTSIDE DISPOSABLE TESTS' > /etc/issue.net

exec /usr/sbin/sshd -D -e \
  -o PasswordAuthentication=yes \
  -o KbdInteractiveAuthentication=no \
  -o PubkeyAuthentication=yes \
  -o PermitRootLogin=no \
  -o AllowUsers=wan \
  -o AuthorizedKeysFile=.ssh/authorized_keys \
  -o Banner=/etc/issue.net \
  -o PidFile=/run/sshd.pid