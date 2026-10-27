#!/bin/sh
# The host mounts ~/.aws read-only at $HOME/.aws-ro (see docker-compose.yml).
# aws-cli needs to write its cache (~/.aws/cli/cache), so we build a writable
# $HOME/.aws: config/credentials are symlinks to the host (read-only, always
# up to date) and 'cli' is copied into a writable dir.
# 'sso' is NOT copied: docker-compose mounts the host's ~/.aws/sso read-write
# straight at $HOME/.aws/sso. Copying it would freeze the SSO token at
# container start, so after an 'aws sso login' on the host the container
# would keep using the expired token ("The SSO session associated with this
# profile has expired") until restarted.
set -e

if [ -d "$HOME/.aws-ro" ]; then
  mkdir -p "$HOME/.aws"
  for entry in "$HOME"/.aws-ro/*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    case "$name" in
      sso)
        # mounted separately (read-write, shared with the host)
        [ -d "$HOME/.aws/sso" ] || ln -sfn "$entry" "$HOME/.aws/sso"
        ;;
      cli)
        mkdir -p "$HOME/.aws/$name"
        cp -a "$entry"/. "$HOME/.aws/$name"/ 2>/dev/null || true
        ;;
      *)
        ln -sfn "$entry" "$HOME/.aws/$name"
        ;;
    esac
  done
fi

exec "$@"
