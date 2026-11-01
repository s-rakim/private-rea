import { NICKNAMES_SET, PEER_REMOVE, ME, HANG_UP, NICKNAME_REMOVE } from '../constants'
import { NicknameActions, NicknameRemoveAction } from '../actions/NicknameActions'
import { RemovePeerAction } from '../actions/PeerActions'
import { config } from '../window'
import omit from 'lodash/omit'
import { HangUpAction } from '../actions/CallActions'

const { nickname, peerId } = config

export type Nicknames = Record<string, string>

const defaultState: Nicknames = {
  [ME]: getLocalNickname(),
}

export function getLocalNickname() {
  return nicknameFromLink() || localStorage && localStorage.nickname || nickname
}

// Tailchat: the app opens a call as /call/<room>#name=<this device's name>,
// so the name box starts with it. The fragment never reaches the server.
function nicknameFromLink(): string {
  try {
    const name = new URLSearchParams(window.location.hash.slice(1)).get('name')
    return (name || '').trim().slice(0, 60)
  } catch {
    return ''
  }
}

function removeNickname(
  state: Nicknames,
  action: NicknameRemoveAction,
): Nicknames {
  const { peerId } = action.payload
  const newState = {
    ...state,
  }
  if (peerId !== ME) {
    delete newState[peerId]
  }
  return newState
}

export default function nicknames(
  state = defaultState,
  action: NicknameActions | RemovePeerAction | HangUpAction,
) {
  switch (action.type) {
    case PEER_REMOVE:
      return omit(state, [action.payload.peerId])
    case HANG_UP:
      return {[ME]: state[ME]}
    case NICKNAME_REMOVE:
      return removeNickname(state, action)
    case NICKNAMES_SET:
      return Object.keys(action.payload).reduce((obj, key) => {
        const value = action.payload[key]
        if (key === peerId) {
          obj[ME] = value
        } else {
          obj[key] = value
        }
        return obj
      }, {[ME]: state[ME]} as Nicknames)
    default:
      return state
  }
}
