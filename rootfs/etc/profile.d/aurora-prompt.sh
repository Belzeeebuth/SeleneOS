# /etc/profile.d/aurora-prompt.sh - Aurora OS: coloured bash prompt and a short greeting.
#
# Sourced by login shells (/etc/profile); Aurora Terminal starts login shells. Only interactive bash
# on a colour terminal is touched. The prompt is replaced at the first prompt (after ~/.bashrc ran),
# and only while it is still a stock one, so a PS1 customised in ~/.bashrc always wins.
# Opt out: AURORA_PROMPT=0 in ~/.profile. No greeting: touch ~/.hushlogin.

[ -n "${BASH_VERSION:-}" ] || return 0
case $- in *i*) ;; *) return 0 ;; esac
case "${TERM:-}" in xterm-color|*-256color|xterm-kitty|alacritty|foot*|*-truecolor) ;; *) return 0 ;; esac
[ "${AURORA_PROMPT:-1}" = 0 ] && return 0

# "[1] " in red when the last command failed (\001/\002 mark non-printing bytes for readline).
__aurora_ps1_status() {
  local s=$?
  [ "$s" -ne 0 ] && printf '\001\033[31m\002[%s]\001\033[0m\002 ' "$s"
  return "$s"
}

# Current git branch, if any (cheap: reads .git/HEAD, no git process).
__aurora_ps1_git() {
  local s=$? d=$PWD head
  while [ -n "$d" ]; do
    if [ -f "$d/.git/HEAD" ]; then
      read -r head < "$d/.git/HEAD" 2>/dev/null || break
      case "$head" in
        ref:\ refs/heads/*) printf ' \001\033[35m\002(%s)\001\033[0m\002' "${head#ref: refs/heads/}" ;;
        *) printf ' \001\033[35m\002(%.7s)\001\033[0m\002' "$head" ;;
      esac
      break
    fi
    d=${d%/*}
  done
  return "$s"
}

# PS0 runs right before a command: title the terminal tab with that command ("htop", "make -j8").
__aurora_ps0() {
  local c
  c=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null) || return 0
  c=${c#"${c%%[![:space:]]*}"}
  c=${c#*[[:space:]]}
  c=${c#"${c%%[![:space:]]*}"}
  c=${c//[$'\001'-$'\037']/ }
  [ -n "$c" ] && printf '\033]0;%s\007' "${c:0:80}"
  return 0
}

__aurora_prompt_apply() {
  case "$PS1" in
    '\s-\v\$ ' | *'\u@\h:\w\$ ' | *'\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ ') ;;
    *) return 0 ;;
  esac
  local user_color='1;32'
  [ "${EUID:-$(id -u)}" -eq 0 ] && user_color='1;31'
  [ -z "${PS0:-}" ] && PS0='$(__aurora_ps0)'
  PS1='\[\e]0;\u@\h: \w\a\]$(__aurora_ps1_status)\[\e['"$user_color"'m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]$(__aurora_ps1_git)\$ '
}

__aurora_greeting() {
  [ -f "$HOME/.hushlogin" ] && return 0
  [ "${AURORA_TERMINAL:-}" = 1 ] || return 0
  # Once per desktop session.
  local mark="${XDG_RUNTIME_DIR:-/tmp}/aurora-terminal-greeted-${EUID:-0}"
  [ -e "$mark" ] && return 0
  : > "$mark" 2>/dev/null
  local name="Aurora OS"
  if [ -r /etc/os-release ]; then
    name=$(. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-$NAME}")
  fi
  printf '\033[1;36m%s\033[0m \033[2m· Linux %s · bash %s\033[0m\n' "$name" "$(uname -r)" "${BASH_VERSION%%(*}"
  case "${LANG:-}" in
    fr*) printf '\033[2mAide : help, man <commande>. Nouvel onglet : Ctrl+Maj+T. Rechercher : Ctrl+Maj+F.\033[0m\n\n' ;;
    *) printf '\033[2mHelp: help, man <command>. New tab: Ctrl+Shift+T. Find: Ctrl+Shift+F.\033[0m\n\n' ;;
  esac
}

# Runs once, right before the first prompt, then removes itself from PROMPT_COMMAND.
__aurora_prompt_init() {
  local s=$?
  __aurora_prompt_apply
  __aurora_greeting
  PROMPT_COMMAND=${PROMPT_COMMAND//__aurora_prompt_init;/}
  PROMPT_COMMAND=${PROMPT_COMMAND//__aurora_prompt_init/}
  case "$PROMPT_COMMAND" in *aurora-prompt.sh*) PROMPT_COMMAND= ;; esac
  export -n PROMPT_COMMAND 2>/dev/null
  return "$s"
}

case "${PROMPT_COMMAND:-}" in
  *__aurora_prompt_init*) ;;
  '') PROMPT_COMMAND='__aurora_prompt_init' ;;
  *) PROMPT_COMMAND="__aurora_prompt_init;$PROMPT_COMMAND" ;;
esac
