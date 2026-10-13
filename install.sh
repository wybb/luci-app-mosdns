#!/bin/sh
# Deliberately fail closed: release archives do not provide a trusted signature
# chain here, and must never be installed with certificate checks disabled.
printf '%s\n' 'Automatic installation is disabled in this v2 rebuild.' >&2
printf '%s\n' 'Build packages using a matching official OpenWrt SDK and install reviewed packages through your trusted OpenWrt package feed.' >&2
printf '%s\n' 'Official SDK documentation: https://openwrt.org/docs/guide-developer/toolchain/using_the_sdk' >&2
exit 1
