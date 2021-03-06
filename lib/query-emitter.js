var deepEquals = require('deep-is');
var arraydiff = require('arraydiff');
var util = require('./util');

function QueryEmitter(request, stream, ids, extra) {
  this.backend = request.backend;
  this.agent = request.agent;
  this.db = request.db;
  this.index = request.index;
  this.query = request.query;
  this.collection = request.collection;
  this.fields = request.fields;
  this.options = request.options;
  this.snapshotProjection = request.snapshotProjection
  this.stream = stream;
  this.ids = ids;
  this.extra = extra;

  this.skipPoll = this.options.skipPoll || util.doNothing;
  this.canPollDoc = this.db.canPollDoc(this.collection, this.query);
  this.pollDebounce =
    (this.options.pollDebounce != null) ? this.options.pollDebounce :
    (this.db.pollDebounce != null) ? this.db.pollDebounce : 0;

  this._polling = false;
  this._pollTimeout = null;
  this._pendingPoll = null;

  this.init();
}
module.exports = QueryEmitter;

QueryEmitter.prototype.init = function() {
  var emitter = this;
  this._defaultCallback = function(err) {
    if (err) emitter.onError(err);
  }
  function readStream() {
    var data;
    while (data = emitter.stream.read()) {
      if (data.error) {
        emitter.onError(data.error);
        continue;
      }
      emitter.update(data);
    }
  }
  readStream();
  emitter.stream.on('readable', readStream);
};

QueryEmitter.prototype.destroy = function() {
  this.stream.destroy();
};

QueryEmitter.prototype._emitTiming = function(action, start) {
  this.backend.emit('timing', action, Date.now() - start, this.index, this.query);
};

QueryEmitter.prototype.update = function(op) {
  var id = op.d;

  // Check if the op's id matches the query before updating the query results
  // and send it through immediately if it does. The current snapshot
  // (including the op) for a newly matched document will get sent in the
  // insert diff, so we don't need to send the op that caused the doc to
  // match. If the doc already exists in the client and isn't otherwise
  // subscribed, the client will need to request the op when it receives the
  // snapshot from the query to bring itself up to date.
  //
  // The client may see the result of the op get reflected before the query
  // results update. This might prove janky in some cases, since a doc could
  // get deleted before it is removed from the results, for example. However,
  // it will mean that ops which don't end up changing the results are
  // received sooner even if query polling takes a while.
  //
  // Alternatively, we could send the op message only after the query has
  // updated, and it would perhaps be ideal to send in the same message to
  // avoid the user seeing transitional states where the doc is updated but
  // the results order is not.
  //
  // We should send the op even if it is the op that causes the document to no
  // longer match the query. If client-side filters are applied to the model
  // to figure out which documents to render in a list, we will want the op
  // that removed the doc from the query to cause the client-side computed
  // list to update.
  if (this.ids.indexOf(id) !== -1) {
    this.onOp(op);
  }

  // Ignore if the database or user function says we don't need to poll
  try {
    if (this.db.skipPoll(this.collection, id, op, this.query)) return this._defaultCallback();
    if (this.skipPoll(this.collection, id, op, this.query)) return this._defaultCallback();
  } catch (err) {
    return this._defaultCallback(err);
  }
  if (this.canPollDoc) {
    // We can query against only the document that was modified to see if the
    // op has changed whether or not it matches the results
    this.queryPollDoc(id, this._defaultCallback);
  } else {
    // We need to do a full poll of the query, because the query uses limits,
    // sorts, or something special
    this.queryPoll(this._defaultCallback);
  }
};

QueryEmitter.prototype._flushPoll = function() {
  if (this._polling || this._pollTimeout) return;
  if (this._pendingPoll) this.queryPoll();
};

QueryEmitter.prototype.queryPoll = function(callback) {
  var emitter = this;

  // Only run a single polling check against mongo at a time per emitter. This
  // matters for two reasons: First, one callback could return before the
  // other. Thus, our result diffs could get out of order, and the clients
  // could end up with results in a funky order and the wrong results being
  // mutated in the query. Second, only having one query executed
  // simultaneously per emitter will act as a natural adaptive rate limiting
  // in case the db is under load.
  //
  // This isn't neccessary for the document polling case, since they operate
  // on a given id and won't accidentally modify the wrong doc. Also, those
  // queries should be faster and are less likely to be the same, so there is
  // less benefit to possible load reduction.
  if (this._polling || this._pollTimeout) {
    if (this._pendingPoll) {
      this._pendingPoll.push(callback);
    } else {
      this._pendingPoll = [callback];
    }
    return;
  }
  this._polling = true;
  var pending = this._pendingPoll;
  this._pendingPoll = null;
  if (this.pollDebounce) {
    this._pollTimeout = setTimeout(function() {
      emitter._pollTimeout = null;
      emitter._flushPoll();
    }, this.pollDebounce);
  }

  var start = Date.now();
  this.db.queryPoll(this.collection, this.query, this.options, function(err, ids, extra) {
    if (err) return emitter._finishPoll(err, callback, pending);
    emitter._emitTiming('query.poll', start);

    // Be nice to not have to do this in such a brute force way
    if (!deepEquals(emitter.extra, extra)) {
      emitter.extra = extra;
      emitter.onExtra(extra);
    }

    var idsDiff = arraydiff(emitter.ids, ids);
    if (idsDiff.length) {
      emitter.ids = ids;
      var inserted = getInserted(idsDiff);
      if (inserted.length) {
        emitter.db.getSnapshotBulk(emitter.collection, inserted, emitter.fields, function(err, snapshotMap) {
          if (err) return emitter._finishPoll(err, callback, pending);
          emitter.backend._sanitizeSnapshotBulk(emitter.agent, emitter.snapshotProjection, emitter.collection, snapshotMap, function(err) {
            if (err) return emitter._finishPoll(err, callback, pending);
            emitter._emitTiming('query.pollGetSnapshotBulk', start);
            var diff = mapDiff(idsDiff, snapshotMap);
            emitter.onDiff(diff);
            emitter._finishPoll(err, callback, pending);
          });
        });
      } else {
        emitter.onDiff(idsDiff);
        emitter._finishPoll(err, callback, pending);
      }
    } else {
      emitter._finishPoll(err, callback, pending);
    }
  });
};
QueryEmitter.prototype._finishPoll = function(err, callback, pending) {
  this._polling = false;
  if (callback) callback(err);
  if (pending) {
    for (var i = 0; i < pending.length; i++) {
      callback = pending[i];
      if (callback) callback(err);
    }
  }
  this._flushPoll();
};

QueryEmitter.prototype.queryPollDoc = function(id, callback) {
  var emitter = this;
  var start = Date.now();
  this.db.queryPollDoc(this.collection, id, this.query, this.options, function(err, matches) {
    if (err) return callback(err);
    emitter._emitTiming('query.pollDoc', start);

    // Check if the document was in the previous results set
    var i = emitter.ids.indexOf(id);

    if (i === -1 && matches) {
      // Add doc to the collection. Order isn't important, so we'll just whack
      // it at the end
      var index = emitter.ids.push(id) - 1;
      // We can get the result to send to the client async, since there is a
      // delay in sending to the client anyway
      emitter.db.getSnapshot(emitter.collection, id, emitter.fields, function(err, snapshot) {
        if (err) return callback(err);
        emitter._emitTiming('query.pollDocGetSnapshot', start);
        var values = [snapshot];
        emitter.onDiff([new arraydiff.InsertDiff(index, values)]);
        callback();
      });
      return;
    }

    if (i !== -1 && !matches) {
      emitter.ids.splice(i, 1);
      emitter.onDiff([new arraydiff.RemoveDiff(i, 1)]);
      return callback();
    }

    callback();
  });
};

// Clients must assign each of these functions syncronously after constructing
// an instance of QueryEmitter. The instance is subscribed to an op stream at
// construction time, and does not buffer emitted events. Diff events assume
// all messages are received and applied in order, so it is critical that none
// are dropped.
QueryEmitter.prototype.onError =
QueryEmitter.prototype.onDiff =
QueryEmitter.prototype.onExtra =
QueryEmitter.prototype.onOp = function() {
  // Silently ignore if the op stream was destroyed already
  if (!this.stream.open) return;
  throw new Error('Required QueryEmitter listener not assigned');
};

function getInserted(diff) {
  var inserted = [];
  for (var i = 0; i < diff.length; i++) {
    var item = diff[i];
    if (item instanceof arraydiff.InsertDiff) {
      for (var j = 0; j < item.values.length; j++) {
        inserted.push(item.values[j]);
      }
    }
  }
  return inserted;
}

function mapDiff(idsDiff, snapshotMap) {
  var diff = [];
  for (var i = 0; i < idsDiff.length; i++) {
    var item = idsDiff[i];
    if (item instanceof arraydiff.InsertDiff) {
      var values = [];
      for (var j = 0; j < item.values.length; j++) {
        var id = item.values[j];
        values.push(snapshotMap[id]);
      }
      diff.push(new arraydiff.InsertDiff(item.index, values));
    } else {
      diff.push(item);
    }
  }
  return diff;
}
