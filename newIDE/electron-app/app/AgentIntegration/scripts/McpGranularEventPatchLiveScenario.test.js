const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findEventJsonPath,
  getEventNodeAtPath,
  getType,
  parseLabel,
} = require('./McpGranularEventPatchLiveScenario');

test('granular live scenario helpers keep canonical event paths aligned with normalized handles', () => {
  const eventsJson = [
    {
      type: 'Group',
      name: 'Root',
      events: [
        { type: { value: 'Comment' }, comment: 'A' },
        { type: { value: 'Comment' }, comment: 'B' },
      ],
    },
  ];
  const events = [
    {
      handle: 'event:group',
      path: [0],
      children: [
        { handle: 'event:a', path: [0, 0], children: [] },
        { handle: 'event:b', path: [0, 1], children: [] },
      ],
    },
  ];

  const eventPath = findEventJsonPath(
    eventsJson,
    eventJson => eventJson.comment === 'B'
  );
  assert.deepEqual(eventPath, [0, 1]);
  assert.equal(getEventNodeAtPath(events, eventPath).handle, 'event:b');
  assert.equal(getType(eventsJson[0]), 'Group');
  assert.equal(getType(eventsJson[0].events[0]), 'Comment');
});

test('granular live scenario label parser is deterministic', () => {
  assert.equal(parseLabel([]), 'live');
  assert.equal(parseLabel(['--label', 'source-final']), 'source-final');
  assert.equal(
    parseLabel(['x', '--label', 'win-unpacked-final']),
    'win-unpacked-final'
  );
});
