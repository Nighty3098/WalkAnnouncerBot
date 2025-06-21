// FSM для сбора информации о прогулке

const STATES = {
  IDLE: 'IDLE',
  TOPIC: 'TOPIC',
  PLACE: 'PLACE',
  DATETIME: 'DATETIME',
  CONTACT: 'CONTACT',
  DESCRIPTION: 'DESCRIPTION',
  PHOTO: 'PHOTO',
  PREVIEW: 'PREVIEW',
};

// В памяти: userId -> { state, draft }
const userStates = {};

function startFSM(userId) {
  userStates[userId] = {
    state: STATES.TOPIC,
    draft: {},
  };
}

function getState(userId) {
  return userStates[userId]?.state || STATES.IDLE;
}

function setState(userId, state) {
  if (!userStates[userId]) userStates[userId] = { draft: {} };
  userStates[userId].state = state;
}

function setDraftField(userId, field, value) {
  if (!userStates[userId]) userStates[userId] = { draft: {} };
  userStates[userId].draft[field] = value;
}

function getDraft(userId) {
  return userStates[userId]?.draft || {};
}

function resetFSM(userId) {
  delete userStates[userId];
}

module.exports = {
  STATES,
  startFSM,
  getState,
  setState,
  setDraftField,
  getDraft,
  resetFSM,
}; 
