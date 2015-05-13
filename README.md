[![Circle CI](https://circleci.com/gh/inhumanecards/inhumane.cards.svg?style=shield)](https://circleci.com/gh/inhumanecards/inhumane.cards) [![Stories in Ready](https://badge.waffle.io/inhumanecards/inhumane.cards.png?label=ready&title=Ready)](http://waffle.io/inhumanecards/inhumane.cards)

# inhumane-cards
A Cards Against Humanity clone

## Frontend Technologies
* React
* Some kind of Flux framework, undecided which one
* Possibly immutable.js (I'd like to use immutable data as much as possible - where it makes sense)
* WebSockets
* WebRTC (maybe - there's no iPhone support, so it's lower priority)
* Radium (for CSS)
* Babel (transpiling)
* jspm (package management)

## Testing
### TDD
```
mocha test/spec --recursive --watch
```

### Integration Tests
```
foreman start
mocha test/spec --recursive
```

## Environment Variables
We recommmend running a local server instance with [foreman](https://github.com/ddollar/foreman) which simply uses a `.env` file in the root directory to specificy environmental variables.
### Required
* REDIS_URL=redis://`username`:`password`@`hostname`:`port`
