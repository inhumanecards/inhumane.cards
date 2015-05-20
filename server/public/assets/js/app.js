"format register";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function dedupe(deps) {
    var newDeps = [];
    for (var i = 0, l = deps.length; i < l; i++)
      if (indexOf.call(newDeps, deps[i]) == -1)
        newDeps.push(deps[i])
    return newDeps;
  }

  function register(name, deps, declare, execute) {
    if (typeof name != 'string')
      throw "System.register provided no module name";
    
    var entry;

    // dynamic
    if (typeof declare == 'boolean') {
      entry = {
        declarative: false,
        deps: deps,
        execute: execute,
        executingRequire: declare
      };
    }
    else {
      // ES6 declarative
      entry = {
        declarative: true,
        deps: deps,
        declare: declare
      };
    }

    entry.name = name;
    
    // we never overwrite an existing define
    if (!defined[name])
      defined[name] = entry; 

    entry.deps = dedupe(entry.deps);

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }

  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      
      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;
      
      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {
        
        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          var importerIndex = indexOf.call(importerModule.dependencies, module);
          importerModule.setters[importerIndex](exports);
        }
      }

      module.locked = false;
      return value;
    });
    
    module.setters = declaration.setters;
    module.execute = declaration.execute;

    if (!module.setters || !module.execute)
      throw new TypeError("Invalid System.register form for " + entry.name);

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = { 'default': depEntry.module.exports, __useDefault: true };
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);
    
      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);
    
    if (output)
      module.exports = output;
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    var module = entry.declarative ? entry.module.exports : { 'default': entry.module.exports, '__useDefault': true };

    // return the defined module object
    return modules[name] = module;
  };

  return function(main, declare) {

    var System;

    // if there's a system loader, define onto it
    if (typeof System != 'undefined' && System.register) {
      declare(System);
      System['import'](main);
    }
    // otherwise, self execute
    else {
      declare(System = {
        register: register, 
        get: load, 
        set: function(name, module) {
          modules[name] = module; 
        },
        newModule: function(module) {
          return module;
        },
        global: global 
      });
      System.set('@empty', System.newModule({}));
      load(main);
    }
  };

})(typeof window != 'undefined' ? window : global)
/* ('mainModule', function(System) {
  System.register(...);
}); */

('~/app', function(System) {

System.register("npm:lodash@3.9.1/internal/arrayEach", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function arrayEach(array, iteratee) {
    var index = -1,
        length = array.length;
    while (++index < length) {
      if (iteratee(array[index], index, array) === false) {
        break;
      }
    }
    return array;
  }
  module.exports = arrayEach;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/arrayCopy", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function arrayCopy(source, array) {
    var index = -1,
        length = source.length;
    array || (array = Array(length));
    while (++index < length) {
      array[index] = source[index];
    }
    return array;
  }
  module.exports = arrayCopy;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseProperty", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function baseProperty(key) {
    return function(object) {
      return object == null ? undefined : object[key];
    };
  }
  module.exports = baseProperty;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/isLength", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var MAX_SAFE_INTEGER = 9007199254740991;
  function isLength(value) {
    return typeof value == 'number' && value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
  }
  module.exports = isLength;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/isObjectLike", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function isObjectLike(value) {
    return !!value && typeof value == 'object';
  }
  module.exports = isObjectLike;
  global.define = __define;
  return module.exports;
});



System.register("npm:process@0.10.1/browser", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var process = module.exports = {};
  var queue = [];
  var draining = false;
  function drainQueue() {
    if (draining) {
      return ;
    }
    draining = true;
    var currentQueue;
    var len = queue.length;
    while (len) {
      currentQueue = queue;
      queue = [];
      var i = -1;
      while (++i < len) {
        currentQueue[i]();
      }
      len = queue.length;
    }
    draining = false;
  }
  process.nextTick = function(fun) {
    queue.push(fun);
    if (!draining) {
      setTimeout(drainQueue, 0);
    }
  };
  process.title = 'browser';
  process.browser = true;
  process.env = {};
  process.argv = [];
  process.version = '';
  process.versions = {};
  function noop() {}
  process.on = noop;
  process.addListener = noop;
  process.once = noop;
  process.off = noop;
  process.removeListener = noop;
  process.removeAllListeners = noop;
  process.emit = noop;
  process.binding = function(name) {
    throw new Error('process.binding is not supported');
  };
  process.cwd = function() {
    return '/';
  };
  process.chdir = function(dir) {
    throw new Error('process.chdir is not supported');
  };
  process.umask = function() {
    return 0;
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/lang/isObject", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function isObject(value) {
    var type = typeof value;
    return !!value && (type == 'object' || type == 'function');
  }
  module.exports = isObject;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/isIndex", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var MAX_SAFE_INTEGER = 9007199254740991;
  function isIndex(value, length) {
    value = typeof value == 'number' ? value : parseFloat(value);
    length = length == null ? MAX_SAFE_INTEGER : length;
    return value > -1 && value % 1 == 0 && value < length;
  }
  module.exports = isIndex;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/lang/isTypedArray", ["npm:lodash@3.9.1/internal/isLength", "npm:lodash@3.9.1/internal/isObjectLike"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isLength = require("npm:lodash@3.9.1/internal/isLength"),
      isObjectLike = require("npm:lodash@3.9.1/internal/isObjectLike");
  var argsTag = '[object Arguments]',
      arrayTag = '[object Array]',
      boolTag = '[object Boolean]',
      dateTag = '[object Date]',
      errorTag = '[object Error]',
      funcTag = '[object Function]',
      mapTag = '[object Map]',
      numberTag = '[object Number]',
      objectTag = '[object Object]',
      regexpTag = '[object RegExp]',
      setTag = '[object Set]',
      stringTag = '[object String]',
      weakMapTag = '[object WeakMap]';
  var arrayBufferTag = '[object ArrayBuffer]',
      float32Tag = '[object Float32Array]',
      float64Tag = '[object Float64Array]',
      int8Tag = '[object Int8Array]',
      int16Tag = '[object Int16Array]',
      int32Tag = '[object Int32Array]',
      uint8Tag = '[object Uint8Array]',
      uint8ClampedTag = '[object Uint8ClampedArray]',
      uint16Tag = '[object Uint16Array]',
      uint32Tag = '[object Uint32Array]';
  var typedArrayTags = {};
  typedArrayTags[float32Tag] = typedArrayTags[float64Tag] = typedArrayTags[int8Tag] = typedArrayTags[int16Tag] = typedArrayTags[int32Tag] = typedArrayTags[uint8Tag] = typedArrayTags[uint8ClampedTag] = typedArrayTags[uint16Tag] = typedArrayTags[uint32Tag] = true;
  typedArrayTags[argsTag] = typedArrayTags[arrayTag] = typedArrayTags[arrayBufferTag] = typedArrayTags[boolTag] = typedArrayTags[dateTag] = typedArrayTags[errorTag] = typedArrayTags[funcTag] = typedArrayTags[mapTag] = typedArrayTags[numberTag] = typedArrayTags[objectTag] = typedArrayTags[regexpTag] = typedArrayTags[setTag] = typedArrayTags[stringTag] = typedArrayTags[weakMapTag] = false;
  var objectProto = Object.prototype;
  var objToString = objectProto.toString;
  function isTypedArray(value) {
    return isObjectLike(value) && isLength(value.length) && !!typedArrayTags[objToString.call(value)];
  }
  module.exports = isTypedArray;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseCopy", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function baseCopy(source, props, object) {
    object || (object = {});
    var index = -1,
        length = props.length;
    while (++index < length) {
      var key = props[index];
      object[key] = source[key];
    }
    return object;
  }
  module.exports = baseCopy;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/shimKeys", ["npm:lodash@3.9.1/lang/isArguments", "npm:lodash@3.9.1/lang/isArray", "npm:lodash@3.9.1/internal/isIndex", "npm:lodash@3.9.1/internal/isLength", "npm:lodash@3.9.1/object/keysIn"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isArguments = require("npm:lodash@3.9.1/lang/isArguments"),
      isArray = require("npm:lodash@3.9.1/lang/isArray"),
      isIndex = require("npm:lodash@3.9.1/internal/isIndex"),
      isLength = require("npm:lodash@3.9.1/internal/isLength"),
      keysIn = require("npm:lodash@3.9.1/object/keysIn");
  var objectProto = Object.prototype;
  var hasOwnProperty = objectProto.hasOwnProperty;
  function shimKeys(object) {
    var props = keysIn(object),
        propsLength = props.length,
        length = propsLength && object.length;
    var allowIndexes = !!length && isLength(length) && (isArray(object) || isArguments(object));
    var index = -1,
        result = [];
    while (++index < propsLength) {
      var key = props[index];
      if ((allowIndexes && isIndex(key, length)) || hasOwnProperty.call(object, key)) {
        result.push(key);
      }
    }
    return result;
  }
  module.exports = shimKeys;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/utility/identity", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function identity(value) {
    return value;
  }
  module.exports = identity;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/isIterateeCall", ["npm:lodash@3.9.1/internal/isArrayLike", "npm:lodash@3.9.1/internal/isIndex", "npm:lodash@3.9.1/lang/isObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isArrayLike = require("npm:lodash@3.9.1/internal/isArrayLike"),
      isIndex = require("npm:lodash@3.9.1/internal/isIndex"),
      isObject = require("npm:lodash@3.9.1/lang/isObject");
  function isIterateeCall(value, index, object) {
    if (!isObject(object)) {
      return false;
    }
    var type = typeof index;
    if (type == 'number' ? (isArrayLike(object) && isIndex(index, object.length)) : (type == 'string' && index in object)) {
      var other = object[index];
      return value === value ? (value === other) : (other !== other);
    }
    return false;
  }
  module.exports = isIterateeCall;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/function/restParam", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var FUNC_ERROR_TEXT = 'Expected a function';
  var nativeMax = Math.max;
  function restParam(func, start) {
    if (typeof func != 'function') {
      throw new TypeError(FUNC_ERROR_TEXT);
    }
    start = nativeMax(start === undefined ? (func.length - 1) : (+start || 0), 0);
    return function() {
      var args = arguments,
          index = -1,
          length = nativeMax(args.length - start, 0),
          rest = Array(length);
      while (++index < length) {
        rest[index] = args[start + index];
      }
      switch (start) {
        case 0:
          return func.call(this, rest);
        case 1:
          return func.call(this, args[0], rest);
        case 2:
          return func.call(this, args[0], args[1], rest);
      }
      var otherArgs = Array(start + 1);
      index = -1;
      while (++index < start) {
        otherArgs[index] = args[index];
      }
      otherArgs[start] = rest;
      return func.apply(this, otherArgs);
    };
  }
  module.exports = restParam;
  global.define = __define;
  return module.exports;
});



System.register("npm:radium@0.10.3/modules/mixins/util/mouse-up-listener", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var _callbacks = [];
  var _mouseUpListenerIsActive = false;
  var _handleMouseUp = function(ev) {
    _callbacks.forEach(function(callback) {
      callback(ev);
    });
  };
  var subscribe = function(callback) {
    if (_callbacks.indexOf(callback) === -1) {
      _callbacks.push(callback);
    }
    if (!_mouseUpListenerIsActive) {
      window.addEventListener('mouseup', _handleMouseUp);
      _mouseUpListenerIsActive = true;
    }
    return {remove: function() {
        var index = _callbacks.indexOf(callback);
        _callbacks.splice(index, 1);
        if (_callbacks.length === 0 && _mouseUpListenerIsActive) {
          window.removeEventListener('mouseup', _handleMouseUp);
          _mouseUpListenerIsActive = false;
        }
      }};
  };
  module.exports = {subscribe: subscribe};
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/invariant", ["github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    "use strict";
    var invariant = function(condition, format, a, b, c, d, e, f) {
      if ("production" !== process.env.NODE_ENV) {
        if (format === undefined) {
          throw new Error('invariant requires an error message argument');
        }
      }
      if (!condition) {
        var error;
        if (format === undefined) {
          error = new Error('Minified exception occurred; use the non-minified dev environment ' + 'for the full error message and additional helpful warnings.');
        } else {
          var args = [a, b, c, d, e, f];
          var argIndex = 0;
          error = new Error('Invariant Violation: ' + format.replace(/%s/g, function() {
            return args[argIndex++];
          }));
        }
        error.framesToPop = 1;
        throw error;
      }
    };
    module.exports = invariant;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/PooledClass", ["npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var oneArgumentPooler = function(copyFieldsFrom) {
      var Klass = this;
      if (Klass.instancePool.length) {
        var instance = Klass.instancePool.pop();
        Klass.call(instance, copyFieldsFrom);
        return instance;
      } else {
        return new Klass(copyFieldsFrom);
      }
    };
    var twoArgumentPooler = function(a1, a2) {
      var Klass = this;
      if (Klass.instancePool.length) {
        var instance = Klass.instancePool.pop();
        Klass.call(instance, a1, a2);
        return instance;
      } else {
        return new Klass(a1, a2);
      }
    };
    var threeArgumentPooler = function(a1, a2, a3) {
      var Klass = this;
      if (Klass.instancePool.length) {
        var instance = Klass.instancePool.pop();
        Klass.call(instance, a1, a2, a3);
        return instance;
      } else {
        return new Klass(a1, a2, a3);
      }
    };
    var fiveArgumentPooler = function(a1, a2, a3, a4, a5) {
      var Klass = this;
      if (Klass.instancePool.length) {
        var instance = Klass.instancePool.pop();
        Klass.call(instance, a1, a2, a3, a4, a5);
        return instance;
      } else {
        return new Klass(a1, a2, a3, a4, a5);
      }
    };
    var standardReleaser = function(instance) {
      var Klass = this;
      ("production" !== process.env.NODE_ENV ? invariant(instance instanceof Klass, 'Trying to release an instance into a pool of a different type.') : invariant(instance instanceof Klass));
      if (instance.destructor) {
        instance.destructor();
      }
      if (Klass.instancePool.length < Klass.poolSize) {
        Klass.instancePool.push(instance);
      }
    };
    var DEFAULT_POOL_SIZE = 10;
    var DEFAULT_POOLER = oneArgumentPooler;
    var addPoolingTo = function(CopyConstructor, pooler) {
      var NewKlass = CopyConstructor;
      NewKlass.instancePool = [];
      NewKlass.getPooled = pooler || DEFAULT_POOLER;
      if (!NewKlass.poolSize) {
        NewKlass.poolSize = DEFAULT_POOL_SIZE;
      }
      NewKlass.release = standardReleaser;
      return NewKlass;
    };
    var PooledClass = {
      addPoolingTo: addPoolingTo,
      oneArgumentPooler: oneArgumentPooler,
      twoArgumentPooler: twoArgumentPooler,
      threeArgumentPooler: threeArgumentPooler,
      fiveArgumentPooler: fiveArgumentPooler
    };
    module.exports = PooledClass;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/Object.assign", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  function assign(target, sources) {
    if (target == null) {
      throw new TypeError('Object.assign target cannot be null or undefined');
    }
    var to = Object(target);
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    for (var nextIndex = 1; nextIndex < arguments.length; nextIndex++) {
      var nextSource = arguments[nextIndex];
      if (nextSource == null) {
        continue;
      }
      var from = Object(nextSource);
      for (var key in from) {
        if (hasOwnProperty.call(from, key)) {
          to[key] = from[key];
        }
      }
    }
    return to;
  }
  module.exports = assign;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/emptyObject", ["github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    "use strict";
    var emptyObject = {};
    if ("production" !== process.env.NODE_ENV) {
      Object.freeze(emptyObject);
    }
    module.exports = emptyObject;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/emptyFunction", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function makeEmptyFunction(arg) {
    return function() {
      return arg;
    };
  }
  function emptyFunction() {}
  emptyFunction.thatReturns = makeEmptyFunction;
  emptyFunction.thatReturnsFalse = makeEmptyFunction(false);
  emptyFunction.thatReturnsTrue = makeEmptyFunction(true);
  emptyFunction.thatReturnsNull = makeEmptyFunction(null);
  emptyFunction.thatReturnsThis = function() {
    return this;
  };
  emptyFunction.thatReturnsArgument = function(arg) {
    return arg;
  };
  module.exports = emptyFunction;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactCurrentOwner", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ReactCurrentOwner = {current: null};
  module.exports = ReactCurrentOwner;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactRootIndex", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ReactRootIndexInjection = {injectCreateReactRootIndex: function(_createReactRootIndex) {
      ReactRootIndex.createReactRootIndex = _createReactRootIndex;
    }};
  var ReactRootIndex = {
    createReactRootIndex: null,
    injection: ReactRootIndexInjection
  };
  module.exports = ReactRootIndex;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/getIteratorFn", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ITERATOR_SYMBOL = typeof Symbol === 'function' && Symbol.iterator;
  var FAUX_ITERATOR_SYMBOL = '@@iterator';
  function getIteratorFn(maybeIterable) {
    var iteratorFn = maybeIterable && ((ITERATOR_SYMBOL && maybeIterable[ITERATOR_SYMBOL] || maybeIterable[FAUX_ITERATOR_SYMBOL]));
    if (typeof iteratorFn === 'function') {
      return iteratorFn;
    }
  }
  module.exports = getIteratorFn;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactLifeCycle", ["github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactLifeCycle = {
      currentlyMountingInstance: null,
      currentlyUnmountingInstance: null
    };
    module.exports = ReactLifeCycle;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactInstanceMap", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ReactInstanceMap = {
    remove: function(key) {
      key._reactInternalInstance = undefined;
    },
    get: function(key) {
      return key._reactInternalInstance;
    },
    has: function(key) {
      return key._reactInternalInstance !== undefined;
    },
    set: function(key, value) {
      key._reactInternalInstance = value;
    }
  };
  module.exports = ReactInstanceMap;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/CallbackQueue", ["npm:react@0.13.3/lib/PooledClass", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var PooledClass = require("npm:react@0.13.3/lib/PooledClass");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    function CallbackQueue() {
      this._callbacks = null;
      this._contexts = null;
    }
    assign(CallbackQueue.prototype, {
      enqueue: function(callback, context) {
        this._callbacks = this._callbacks || [];
        this._contexts = this._contexts || [];
        this._callbacks.push(callback);
        this._contexts.push(context);
      },
      notifyAll: function() {
        var callbacks = this._callbacks;
        var contexts = this._contexts;
        if (callbacks) {
          ("production" !== process.env.NODE_ENV ? invariant(callbacks.length === contexts.length, 'Mismatched list of contexts in callback queue') : invariant(callbacks.length === contexts.length));
          this._callbacks = null;
          this._contexts = null;
          for (var i = 0,
              l = callbacks.length; i < l; i++) {
            callbacks[i].call(contexts[i]);
          }
          callbacks.length = 0;
          contexts.length = 0;
        }
      },
      reset: function() {
        this._callbacks = null;
        this._contexts = null;
      },
      destructor: function() {
        this.reset();
      }
    });
    PooledClass.addPoolingTo(CallbackQueue);
    module.exports = CallbackQueue;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactPerf", ["github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactPerf = {
      enableMeasure: false,
      storedMeasure: _noMeasure,
      measureMethods: function(object, objectName, methodNames) {
        if ("production" !== process.env.NODE_ENV) {
          for (var key in methodNames) {
            if (!methodNames.hasOwnProperty(key)) {
              continue;
            }
            object[key] = ReactPerf.measure(objectName, methodNames[key], object[key]);
          }
        }
      },
      measure: function(objName, fnName, func) {
        if ("production" !== process.env.NODE_ENV) {
          var measuredFunc = null;
          var wrapper = function() {
            if (ReactPerf.enableMeasure) {
              if (!measuredFunc) {
                measuredFunc = ReactPerf.storedMeasure(objName, fnName, func);
              }
              return measuredFunc.apply(this, arguments);
            }
            return func.apply(this, arguments);
          };
          wrapper.displayName = objName + '_' + fnName;
          return wrapper;
        }
        return func;
      },
      injection: {injectMeasure: function(measure) {
          ReactPerf.storedMeasure = measure;
        }}
    };
    function _noMeasure(objName, fnName, func) {
      return func;
    }
    module.exports = ReactPerf;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactOwner", ["npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var ReactOwner = {
      isValidOwner: function(object) {
        return !!((object && typeof object.attachRef === 'function' && typeof object.detachRef === 'function'));
      },
      addComponentAsRefTo: function(component, ref, owner) {
        ("production" !== process.env.NODE_ENV ? invariant(ReactOwner.isValidOwner(owner), 'addComponentAsRefTo(...): Only a ReactOwner can have refs. This ' + 'usually means that you\'re trying to add a ref to a component that ' + 'doesn\'t have an owner (that is, was not created inside of another ' + 'component\'s `render` method). Try rendering this component inside of ' + 'a new top-level component which will hold the ref.') : invariant(ReactOwner.isValidOwner(owner)));
        owner.attachRef(ref, component);
      },
      removeComponentAsRefFrom: function(component, ref, owner) {
        ("production" !== process.env.NODE_ENV ? invariant(ReactOwner.isValidOwner(owner), 'removeComponentAsRefFrom(...): Only a ReactOwner can have refs. This ' + 'usually means that you\'re trying to remove a ref to a component that ' + 'doesn\'t have an owner (that is, was not created inside of another ' + 'component\'s `render` method). Try rendering this component inside of ' + 'a new top-level component which will hold the ref.') : invariant(ReactOwner.isValidOwner(owner)));
        if (owner.getPublicInstance().refs[ref] === component.getPublicInstance()) {
          owner.detachRef(ref);
        }
      }
    };
    module.exports = ReactOwner;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactPropTypeLocations", ["npm:react@0.13.3/lib/keyMirror"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var keyMirror = require("npm:react@0.13.3/lib/keyMirror");
  var ReactPropTypeLocations = keyMirror({
    prop: null,
    context: null,
    childContext: null
  });
  module.exports = ReactPropTypeLocations;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactPropTypeLocationNames", ["github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactPropTypeLocationNames = {};
    if ("production" !== process.env.NODE_ENV) {
      ReactPropTypeLocationNames = {
        prop: 'prop',
        context: 'context',
        childContext: 'child context'
      };
    }
    module.exports = ReactPropTypeLocationNames;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactNativeComponent", ["npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var autoGenerateWrapperClass = null;
    var genericComponentClass = null;
    var tagToComponentClass = {};
    var textComponentClass = null;
    var ReactNativeComponentInjection = {
      injectGenericComponentClass: function(componentClass) {
        genericComponentClass = componentClass;
      },
      injectTextComponentClass: function(componentClass) {
        textComponentClass = componentClass;
      },
      injectComponentClasses: function(componentClasses) {
        assign(tagToComponentClass, componentClasses);
      },
      injectAutoWrapper: function(wrapperFactory) {
        autoGenerateWrapperClass = wrapperFactory;
      }
    };
    function getComponentClassForElement(element) {
      if (typeof element.type === 'function') {
        return element.type;
      }
      var tag = element.type;
      var componentClass = tagToComponentClass[tag];
      if (componentClass == null) {
        tagToComponentClass[tag] = componentClass = autoGenerateWrapperClass(tag);
      }
      return componentClass;
    }
    function createInternalComponent(element) {
      ("production" !== process.env.NODE_ENV ? invariant(genericComponentClass, 'There is no registered component for the tag %s', element.type) : invariant(genericComponentClass));
      return new genericComponentClass(element.type, element.props);
    }
    function createInstanceForText(text) {
      return new textComponentClass(text);
    }
    function isTextComponent(component) {
      return component instanceof textComponentClass;
    }
    var ReactNativeComponent = {
      getComponentClassForElement: getComponentClassForElement,
      createInternalComponent: createInternalComponent,
      createInstanceForText: createInstanceForText,
      isTextComponent: isTextComponent,
      injection: ReactNativeComponentInjection
    };
    module.exports = ReactNativeComponent;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/Transaction", ["npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var Mixin = {
      reinitializeTransaction: function() {
        this.transactionWrappers = this.getTransactionWrappers();
        if (!this.wrapperInitData) {
          this.wrapperInitData = [];
        } else {
          this.wrapperInitData.length = 0;
        }
        this._isInTransaction = false;
      },
      _isInTransaction: false,
      getTransactionWrappers: null,
      isInTransaction: function() {
        return !!this._isInTransaction;
      },
      perform: function(method, scope, a, b, c, d, e, f) {
        ("production" !== process.env.NODE_ENV ? invariant(!this.isInTransaction(), 'Transaction.perform(...): Cannot initialize a transaction when there ' + 'is already an outstanding transaction.') : invariant(!this.isInTransaction()));
        var errorThrown;
        var ret;
        try {
          this._isInTransaction = true;
          errorThrown = true;
          this.initializeAll(0);
          ret = method.call(scope, a, b, c, d, e, f);
          errorThrown = false;
        } finally {
          try {
            if (errorThrown) {
              try {
                this.closeAll(0);
              } catch (err) {}
            } else {
              this.closeAll(0);
            }
          } finally {
            this._isInTransaction = false;
          }
        }
        return ret;
      },
      initializeAll: function(startIndex) {
        var transactionWrappers = this.transactionWrappers;
        for (var i = startIndex; i < transactionWrappers.length; i++) {
          var wrapper = transactionWrappers[i];
          try {
            this.wrapperInitData[i] = Transaction.OBSERVED_ERROR;
            this.wrapperInitData[i] = wrapper.initialize ? wrapper.initialize.call(this) : null;
          } finally {
            if (this.wrapperInitData[i] === Transaction.OBSERVED_ERROR) {
              try {
                this.initializeAll(i + 1);
              } catch (err) {}
            }
          }
        }
      },
      closeAll: function(startIndex) {
        ("production" !== process.env.NODE_ENV ? invariant(this.isInTransaction(), 'Transaction.closeAll(): Cannot close transaction when none are open.') : invariant(this.isInTransaction()));
        var transactionWrappers = this.transactionWrappers;
        for (var i = startIndex; i < transactionWrappers.length; i++) {
          var wrapper = transactionWrappers[i];
          var initData = this.wrapperInitData[i];
          var errorThrown;
          try {
            errorThrown = true;
            if (initData !== Transaction.OBSERVED_ERROR && wrapper.close) {
              wrapper.close.call(this, initData);
            }
            errorThrown = false;
          } finally {
            if (errorThrown) {
              try {
                this.closeAll(i + 1);
              } catch (e) {}
            }
          }
        }
        this.wrapperInitData.length = 0;
      }
    };
    var Transaction = {
      Mixin: Mixin,
      OBSERVED_ERROR: {}
    };
    module.exports = Transaction;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactErrorUtils", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var ReactErrorUtils = {guard: function(func, name) {
      return func;
    }};
  module.exports = ReactErrorUtils;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/keyOf", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var keyOf = function(oneKeyObj) {
    var key;
    for (key in oneKeyObj) {
      if (!oneKeyObj.hasOwnProperty(key)) {
        continue;
      }
      return key;
    }
    return null;
  };
  module.exports = keyOf;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/mapObject", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var hasOwnProperty = Object.prototype.hasOwnProperty;
  function mapObject(object, callback, context) {
    if (!object) {
      return null;
    }
    var result = {};
    for (var name in object) {
      if (hasOwnProperty.call(object, name)) {
        result[name] = callback.call(context, object[name], name, object);
      }
    }
    return result;
  }
  module.exports = mapObject;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/DOMProperty", ["npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var invariant = require("npm:react@0.13.3/lib/invariant");
    function checkMask(value, bitmask) {
      return (value & bitmask) === bitmask;
    }
    var DOMPropertyInjection = {
      MUST_USE_ATTRIBUTE: 0x1,
      MUST_USE_PROPERTY: 0x2,
      HAS_SIDE_EFFECTS: 0x4,
      HAS_BOOLEAN_VALUE: 0x8,
      HAS_NUMERIC_VALUE: 0x10,
      HAS_POSITIVE_NUMERIC_VALUE: 0x20 | 0x10,
      HAS_OVERLOADED_BOOLEAN_VALUE: 0x40,
      injectDOMPropertyConfig: function(domPropertyConfig) {
        var Properties = domPropertyConfig.Properties || {};
        var DOMAttributeNames = domPropertyConfig.DOMAttributeNames || {};
        var DOMPropertyNames = domPropertyConfig.DOMPropertyNames || {};
        var DOMMutationMethods = domPropertyConfig.DOMMutationMethods || {};
        if (domPropertyConfig.isCustomAttribute) {
          DOMProperty._isCustomAttributeFunctions.push(domPropertyConfig.isCustomAttribute);
        }
        for (var propName in Properties) {
          ("production" !== process.env.NODE_ENV ? invariant(!DOMProperty.isStandardName.hasOwnProperty(propName), 'injectDOMPropertyConfig(...): You\'re trying to inject DOM property ' + '\'%s\' which has already been injected. You may be accidentally ' + 'injecting the same DOM property config twice, or you may be ' + 'injecting two configs that have conflicting property names.', propName) : invariant(!DOMProperty.isStandardName.hasOwnProperty(propName)));
          DOMProperty.isStandardName[propName] = true;
          var lowerCased = propName.toLowerCase();
          DOMProperty.getPossibleStandardName[lowerCased] = propName;
          if (DOMAttributeNames.hasOwnProperty(propName)) {
            var attributeName = DOMAttributeNames[propName];
            DOMProperty.getPossibleStandardName[attributeName] = propName;
            DOMProperty.getAttributeName[propName] = attributeName;
          } else {
            DOMProperty.getAttributeName[propName] = lowerCased;
          }
          DOMProperty.getPropertyName[propName] = DOMPropertyNames.hasOwnProperty(propName) ? DOMPropertyNames[propName] : propName;
          if (DOMMutationMethods.hasOwnProperty(propName)) {
            DOMProperty.getMutationMethod[propName] = DOMMutationMethods[propName];
          } else {
            DOMProperty.getMutationMethod[propName] = null;
          }
          var propConfig = Properties[propName];
          DOMProperty.mustUseAttribute[propName] = checkMask(propConfig, DOMPropertyInjection.MUST_USE_ATTRIBUTE);
          DOMProperty.mustUseProperty[propName] = checkMask(propConfig, DOMPropertyInjection.MUST_USE_PROPERTY);
          DOMProperty.hasSideEffects[propName] = checkMask(propConfig, DOMPropertyInjection.HAS_SIDE_EFFECTS);
          DOMProperty.hasBooleanValue[propName] = checkMask(propConfig, DOMPropertyInjection.HAS_BOOLEAN_VALUE);
          DOMProperty.hasNumericValue[propName] = checkMask(propConfig, DOMPropertyInjection.HAS_NUMERIC_VALUE);
          DOMProperty.hasPositiveNumericValue[propName] = checkMask(propConfig, DOMPropertyInjection.HAS_POSITIVE_NUMERIC_VALUE);
          DOMProperty.hasOverloadedBooleanValue[propName] = checkMask(propConfig, DOMPropertyInjection.HAS_OVERLOADED_BOOLEAN_VALUE);
          ("production" !== process.env.NODE_ENV ? invariant(!DOMProperty.mustUseAttribute[propName] || !DOMProperty.mustUseProperty[propName], 'DOMProperty: Cannot require using both attribute and property: %s', propName) : invariant(!DOMProperty.mustUseAttribute[propName] || !DOMProperty.mustUseProperty[propName]));
          ("production" !== process.env.NODE_ENV ? invariant(DOMProperty.mustUseProperty[propName] || !DOMProperty.hasSideEffects[propName], 'DOMProperty: Properties that have side effects must use property: %s', propName) : invariant(DOMProperty.mustUseProperty[propName] || !DOMProperty.hasSideEffects[propName]));
          ("production" !== process.env.NODE_ENV ? invariant(!!DOMProperty.hasBooleanValue[propName] + !!DOMProperty.hasNumericValue[propName] + !!DOMProperty.hasOverloadedBooleanValue[propName] <= 1, 'DOMProperty: Value can be one of boolean, overloaded boolean, or ' + 'numeric value, but not a combination: %s', propName) : invariant(!!DOMProperty.hasBooleanValue[propName] + !!DOMProperty.hasNumericValue[propName] + !!DOMProperty.hasOverloadedBooleanValue[propName] <= 1));
        }
      }
    };
    var defaultValueCache = {};
    var DOMProperty = {
      ID_ATTRIBUTE_NAME: 'data-reactid',
      isStandardName: {},
      getPossibleStandardName: {},
      getAttributeName: {},
      getPropertyName: {},
      getMutationMethod: {},
      mustUseAttribute: {},
      mustUseProperty: {},
      hasSideEffects: {},
      hasBooleanValue: {},
      hasNumericValue: {},
      hasPositiveNumericValue: {},
      hasOverloadedBooleanValue: {},
      _isCustomAttributeFunctions: [],
      isCustomAttribute: function(attributeName) {
        for (var i = 0; i < DOMProperty._isCustomAttributeFunctions.length; i++) {
          var isCustomAttributeFn = DOMProperty._isCustomAttributeFunctions[i];
          if (isCustomAttributeFn(attributeName)) {
            return true;
          }
        }
        return false;
      },
      getDefaultValueForProperty: function(nodeName, prop) {
        var nodeDefaults = defaultValueCache[nodeName];
        var testElement;
        if (!nodeDefaults) {
          defaultValueCache[nodeName] = nodeDefaults = {};
        }
        if (!(prop in nodeDefaults)) {
          testElement = document.createElement(nodeName);
          nodeDefaults[prop] = testElement[prop];
        }
        return nodeDefaults[prop];
      },
      injection: DOMPropertyInjection
    };
    module.exports = DOMProperty;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/escapeTextContentForBrowser", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ESCAPE_LOOKUP = {
    '&': '&amp;',
    '>': '&gt;',
    '<': '&lt;',
    '"': '&quot;',
    '\'': '&#x27;'
  };
  var ESCAPE_REGEX = /[&><"']/g;
  function escaper(match) {
    return ESCAPE_LOOKUP[match];
  }
  function escapeTextContentForBrowser(text) {
    return ('' + text).replace(ESCAPE_REGEX, escaper);
  }
  module.exports = escapeTextContentForBrowser;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/CSSProperty", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var isUnitlessNumber = {
    boxFlex: true,
    boxFlexGroup: true,
    columnCount: true,
    flex: true,
    flexGrow: true,
    flexPositive: true,
    flexShrink: true,
    flexNegative: true,
    fontWeight: true,
    lineClamp: true,
    lineHeight: true,
    opacity: true,
    order: true,
    orphans: true,
    widows: true,
    zIndex: true,
    zoom: true,
    fillOpacity: true,
    strokeDashoffset: true,
    strokeOpacity: true,
    strokeWidth: true
  };
  function prefixKey(prefix, key) {
    return prefix + key.charAt(0).toUpperCase() + key.substring(1);
  }
  var prefixes = ['Webkit', 'ms', 'Moz', 'O'];
  Object.keys(isUnitlessNumber).forEach(function(prop) {
    prefixes.forEach(function(prefix) {
      isUnitlessNumber[prefixKey(prefix, prop)] = isUnitlessNumber[prop];
    });
  });
  var shorthandPropertyExpansions = {
    background: {
      backgroundImage: true,
      backgroundPosition: true,
      backgroundRepeat: true,
      backgroundColor: true
    },
    border: {
      borderWidth: true,
      borderStyle: true,
      borderColor: true
    },
    borderBottom: {
      borderBottomWidth: true,
      borderBottomStyle: true,
      borderBottomColor: true
    },
    borderLeft: {
      borderLeftWidth: true,
      borderLeftStyle: true,
      borderLeftColor: true
    },
    borderRight: {
      borderRightWidth: true,
      borderRightStyle: true,
      borderRightColor: true
    },
    borderTop: {
      borderTopWidth: true,
      borderTopStyle: true,
      borderTopColor: true
    },
    font: {
      fontStyle: true,
      fontVariant: true,
      fontWeight: true,
      fontSize: true,
      lineHeight: true,
      fontFamily: true
    }
  };
  var CSSProperty = {
    isUnitlessNumber: isUnitlessNumber,
    shorthandPropertyExpansions: shorthandPropertyExpansions
  };
  module.exports = CSSProperty;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ExecutionEnvironment", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var canUseDOM = !!((typeof window !== 'undefined' && window.document && window.document.createElement));
  var ExecutionEnvironment = {
    canUseDOM: canUseDOM,
    canUseWorkers: typeof Worker !== 'undefined',
    canUseEventListeners: canUseDOM && !!(window.addEventListener || window.attachEvent),
    canUseViewport: canUseDOM && !!window.screen,
    isInWorker: !canUseDOM
  };
  module.exports = ExecutionEnvironment;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/camelize", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var _hyphenPattern = /-(.)/g;
  function camelize(string) {
    return string.replace(_hyphenPattern, function(_, character) {
      return character.toUpperCase();
    });
  }
  module.exports = camelize;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/dangerousStyleValue", ["npm:react@0.13.3/lib/CSSProperty"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var CSSProperty = require("npm:react@0.13.3/lib/CSSProperty");
  var isUnitlessNumber = CSSProperty.isUnitlessNumber;
  function dangerousStyleValue(name, value) {
    var isEmpty = value == null || typeof value === 'boolean' || value === '';
    if (isEmpty) {
      return '';
    }
    var isNonNumeric = isNaN(value);
    if (isNonNumeric || value === 0 || isUnitlessNumber.hasOwnProperty(name) && isUnitlessNumber[name]) {
      return '' + value;
    }
    if (typeof value === 'string') {
      value = value.trim();
    }
    return value + 'px';
  }
  module.exports = dangerousStyleValue;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/hyphenate", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var _uppercasePattern = /([A-Z])/g;
  function hyphenate(string) {
    return string.replace(_uppercasePattern, '-$1').toLowerCase();
  }
  module.exports = hyphenate;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/memoizeStringOnly", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  function memoizeStringOnly(callback) {
    var cache = {};
    return function(string) {
      if (!cache.hasOwnProperty(string)) {
        cache[string] = callback.call(this, string);
      }
      return cache[string];
    };
  }
  module.exports = memoizeStringOnly;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/toArray", ["npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var invariant = require("npm:react@0.13.3/lib/invariant");
    function toArray(obj) {
      var length = obj.length;
      ("production" !== process.env.NODE_ENV ? invariant(!Array.isArray(obj) && (typeof obj === 'object' || typeof obj === 'function'), 'toArray: Array-like object expected') : invariant(!Array.isArray(obj) && (typeof obj === 'object' || typeof obj === 'function')));
      ("production" !== process.env.NODE_ENV ? invariant(typeof length === 'number', 'toArray: Object needs a length property') : invariant(typeof length === 'number'));
      ("production" !== process.env.NODE_ENV ? invariant(length === 0 || (length - 1) in obj, 'toArray: Object should have keys for indices') : invariant(length === 0 || (length - 1) in obj));
      if (obj.hasOwnProperty) {
        try {
          return Array.prototype.slice.call(obj);
        } catch (e) {}
      }
      var ret = Array(length);
      for (var ii = 0; ii < length; ii++) {
        ret[ii] = obj[ii];
      }
      return ret;
    }
    module.exports = toArray;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/getMarkupWrap", ["npm:react@0.13.3/lib/ExecutionEnvironment", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var dummyNode = ExecutionEnvironment.canUseDOM ? document.createElement('div') : null;
    var shouldWrap = {
      'circle': true,
      'clipPath': true,
      'defs': true,
      'ellipse': true,
      'g': true,
      'line': true,
      'linearGradient': true,
      'path': true,
      'polygon': true,
      'polyline': true,
      'radialGradient': true,
      'rect': true,
      'stop': true,
      'text': true
    };
    var selectWrap = [1, '<select multiple="true">', '</select>'];
    var tableWrap = [1, '<table>', '</table>'];
    var trWrap = [3, '<table><tbody><tr>', '</tr></tbody></table>'];
    var svgWrap = [1, '<svg>', '</svg>'];
    var markupWrap = {
      '*': [1, '?<div>', '</div>'],
      'area': [1, '<map>', '</map>'],
      'col': [2, '<table><tbody></tbody><colgroup>', '</colgroup></table>'],
      'legend': [1, '<fieldset>', '</fieldset>'],
      'param': [1, '<object>', '</object>'],
      'tr': [2, '<table><tbody>', '</tbody></table>'],
      'optgroup': selectWrap,
      'option': selectWrap,
      'caption': tableWrap,
      'colgroup': tableWrap,
      'tbody': tableWrap,
      'tfoot': tableWrap,
      'thead': tableWrap,
      'td': trWrap,
      'th': trWrap,
      'circle': svgWrap,
      'clipPath': svgWrap,
      'defs': svgWrap,
      'ellipse': svgWrap,
      'g': svgWrap,
      'line': svgWrap,
      'linearGradient': svgWrap,
      'path': svgWrap,
      'polygon': svgWrap,
      'polyline': svgWrap,
      'radialGradient': svgWrap,
      'rect': svgWrap,
      'stop': svgWrap,
      'text': svgWrap
    };
    function getMarkupWrap(nodeName) {
      ("production" !== process.env.NODE_ENV ? invariant(!!dummyNode, 'Markup wrapping node not initialized') : invariant(!!dummyNode));
      if (!markupWrap.hasOwnProperty(nodeName)) {
        nodeName = '*';
      }
      if (!shouldWrap.hasOwnProperty(nodeName)) {
        if (nodeName === '*') {
          dummyNode.innerHTML = '<link />';
        } else {
          dummyNode.innerHTML = '<' + nodeName + '></' + nodeName + '>';
        }
        shouldWrap[nodeName] = !dummyNode.firstChild;
      }
      return shouldWrap[nodeName] ? markupWrap[nodeName] : null;
    }
    module.exports = getMarkupWrap;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactMultiChildUpdateTypes", ["npm:react@0.13.3/lib/keyMirror"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var keyMirror = require("npm:react@0.13.3/lib/keyMirror");
  var ReactMultiChildUpdateTypes = keyMirror({
    INSERT_MARKUP: null,
    MOVE_EXISTING: null,
    REMOVE_NODE: null,
    TEXT_CONTENT: null
  });
  module.exports = ReactMultiChildUpdateTypes;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/setInnerHTML", ["npm:react@0.13.3/lib/ExecutionEnvironment", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
    var WHITESPACE_TEST = /^[ \r\n\t\f]/;
    var NONVISIBLE_TEST = /<(!--|link|noscript|meta|script|style)[ \r\n\t\f\/>]/;
    var setInnerHTML = function(node, html) {
      node.innerHTML = html;
    };
    if (typeof MSApp !== 'undefined' && MSApp.execUnsafeLocalFunction) {
      setInnerHTML = function(node, html) {
        MSApp.execUnsafeLocalFunction(function() {
          node.innerHTML = html;
        });
      };
    }
    if (ExecutionEnvironment.canUseDOM) {
      var testElement = document.createElement('div');
      testElement.innerHTML = ' ';
      if (testElement.innerHTML === '') {
        setInnerHTML = function(node, html) {
          if (node.parentNode) {
            node.parentNode.replaceChild(node, node);
          }
          if (WHITESPACE_TEST.test(html) || html[0] === '<' && NONVISIBLE_TEST.test(html)) {
            node.innerHTML = '\uFEFF' + html;
            var textNode = node.firstChild;
            if (textNode.data.length === 1) {
              node.removeChild(textNode);
            } else {
              textNode.deleteData(0, 1);
            }
          } else {
            node.innerHTML = html;
          }
        };
      }
    }
    module.exports = setInnerHTML;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/EventPluginRegistry", ["npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var EventPluginOrder = null;
    var namesToPlugins = {};
    function recomputePluginOrdering() {
      if (!EventPluginOrder) {
        return ;
      }
      for (var pluginName in namesToPlugins) {
        var PluginModule = namesToPlugins[pluginName];
        var pluginIndex = EventPluginOrder.indexOf(pluginName);
        ("production" !== process.env.NODE_ENV ? invariant(pluginIndex > -1, 'EventPluginRegistry: Cannot inject event plugins that do not exist in ' + 'the plugin ordering, `%s`.', pluginName) : invariant(pluginIndex > -1));
        if (EventPluginRegistry.plugins[pluginIndex]) {
          continue;
        }
        ("production" !== process.env.NODE_ENV ? invariant(PluginModule.extractEvents, 'EventPluginRegistry: Event plugins must implement an `extractEvents` ' + 'method, but `%s` does not.', pluginName) : invariant(PluginModule.extractEvents));
        EventPluginRegistry.plugins[pluginIndex] = PluginModule;
        var publishedEvents = PluginModule.eventTypes;
        for (var eventName in publishedEvents) {
          ("production" !== process.env.NODE_ENV ? invariant(publishEventForPlugin(publishedEvents[eventName], PluginModule, eventName), 'EventPluginRegistry: Failed to publish event `%s` for plugin `%s`.', eventName, pluginName) : invariant(publishEventForPlugin(publishedEvents[eventName], PluginModule, eventName)));
        }
      }
    }
    function publishEventForPlugin(dispatchConfig, PluginModule, eventName) {
      ("production" !== process.env.NODE_ENV ? invariant(!EventPluginRegistry.eventNameDispatchConfigs.hasOwnProperty(eventName), 'EventPluginHub: More than one plugin attempted to publish the same ' + 'event name, `%s`.', eventName) : invariant(!EventPluginRegistry.eventNameDispatchConfigs.hasOwnProperty(eventName)));
      EventPluginRegistry.eventNameDispatchConfigs[eventName] = dispatchConfig;
      var phasedRegistrationNames = dispatchConfig.phasedRegistrationNames;
      if (phasedRegistrationNames) {
        for (var phaseName in phasedRegistrationNames) {
          if (phasedRegistrationNames.hasOwnProperty(phaseName)) {
            var phasedRegistrationName = phasedRegistrationNames[phaseName];
            publishRegistrationName(phasedRegistrationName, PluginModule, eventName);
          }
        }
        return true;
      } else if (dispatchConfig.registrationName) {
        publishRegistrationName(dispatchConfig.registrationName, PluginModule, eventName);
        return true;
      }
      return false;
    }
    function publishRegistrationName(registrationName, PluginModule, eventName) {
      ("production" !== process.env.NODE_ENV ? invariant(!EventPluginRegistry.registrationNameModules[registrationName], 'EventPluginHub: More than one plugin attempted to publish the same ' + 'registration name, `%s`.', registrationName) : invariant(!EventPluginRegistry.registrationNameModules[registrationName]));
      EventPluginRegistry.registrationNameModules[registrationName] = PluginModule;
      EventPluginRegistry.registrationNameDependencies[registrationName] = PluginModule.eventTypes[eventName].dependencies;
    }
    var EventPluginRegistry = {
      plugins: [],
      eventNameDispatchConfigs: {},
      registrationNameModules: {},
      registrationNameDependencies: {},
      injectEventPluginOrder: function(InjectedEventPluginOrder) {
        ("production" !== process.env.NODE_ENV ? invariant(!EventPluginOrder, 'EventPluginRegistry: Cannot inject event plugin ordering more than ' + 'once. You are likely trying to load more than one copy of React.') : invariant(!EventPluginOrder));
        EventPluginOrder = Array.prototype.slice.call(InjectedEventPluginOrder);
        recomputePluginOrdering();
      },
      injectEventPluginsByName: function(injectedNamesToPlugins) {
        var isOrderingDirty = false;
        for (var pluginName in injectedNamesToPlugins) {
          if (!injectedNamesToPlugins.hasOwnProperty(pluginName)) {
            continue;
          }
          var PluginModule = injectedNamesToPlugins[pluginName];
          if (!namesToPlugins.hasOwnProperty(pluginName) || namesToPlugins[pluginName] !== PluginModule) {
            ("production" !== process.env.NODE_ENV ? invariant(!namesToPlugins[pluginName], 'EventPluginRegistry: Cannot inject two different event plugins ' + 'using the same name, `%s`.', pluginName) : invariant(!namesToPlugins[pluginName]));
            namesToPlugins[pluginName] = PluginModule;
            isOrderingDirty = true;
          }
        }
        if (isOrderingDirty) {
          recomputePluginOrdering();
        }
      },
      getPluginModuleForEvent: function(event) {
        var dispatchConfig = event.dispatchConfig;
        if (dispatchConfig.registrationName) {
          return EventPluginRegistry.registrationNameModules[dispatchConfig.registrationName] || null;
        }
        for (var phase in dispatchConfig.phasedRegistrationNames) {
          if (!dispatchConfig.phasedRegistrationNames.hasOwnProperty(phase)) {
            continue;
          }
          var PluginModule = EventPluginRegistry.registrationNameModules[dispatchConfig.phasedRegistrationNames[phase]];
          if (PluginModule) {
            return PluginModule;
          }
        }
        return null;
      },
      _resetEventPlugins: function() {
        EventPluginOrder = null;
        for (var pluginName in namesToPlugins) {
          if (namesToPlugins.hasOwnProperty(pluginName)) {
            delete namesToPlugins[pluginName];
          }
        }
        EventPluginRegistry.plugins.length = 0;
        var eventNameDispatchConfigs = EventPluginRegistry.eventNameDispatchConfigs;
        for (var eventName in eventNameDispatchConfigs) {
          if (eventNameDispatchConfigs.hasOwnProperty(eventName)) {
            delete eventNameDispatchConfigs[eventName];
          }
        }
        var registrationNameModules = EventPluginRegistry.registrationNameModules;
        for (var registrationName in registrationNameModules) {
          if (registrationNameModules.hasOwnProperty(registrationName)) {
            delete registrationNameModules[registrationName];
          }
        }
      }
    };
    module.exports = EventPluginRegistry;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/accumulateInto", ["npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var invariant = require("npm:react@0.13.3/lib/invariant");
    function accumulateInto(current, next) {
      ("production" !== process.env.NODE_ENV ? invariant(next != null, 'accumulateInto(...): Accumulated items must not be null or undefined.') : invariant(next != null));
      if (current == null) {
        return next;
      }
      var currentIsArray = Array.isArray(current);
      var nextIsArray = Array.isArray(next);
      if (currentIsArray && nextIsArray) {
        current.push.apply(current, next);
        return current;
      }
      if (currentIsArray) {
        current.push(next);
        return current;
      }
      if (nextIsArray) {
        return [current].concat(next);
      }
      return [current, next];
    }
    module.exports = accumulateInto;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/forEachAccumulated", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var forEachAccumulated = function(arr, cb, scope) {
    if (Array.isArray(arr)) {
      arr.forEach(cb, scope);
    } else if (arr) {
      cb.call(scope, arr);
    }
  };
  module.exports = forEachAccumulated;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactEventEmitterMixin", ["npm:react@0.13.3/lib/EventPluginHub"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var EventPluginHub = require("npm:react@0.13.3/lib/EventPluginHub");
  function runEventQueueInBatch(events) {
    EventPluginHub.enqueueEvents(events);
    EventPluginHub.processEventQueue();
  }
  var ReactEventEmitterMixin = {handleTopLevel: function(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent) {
      var events = EventPluginHub.extractEvents(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent);
      runEventQueueInBatch(events);
    }};
  module.exports = ReactEventEmitterMixin;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ViewportMetrics", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ViewportMetrics = {
    currentScrollLeft: 0,
    currentScrollTop: 0,
    refreshScrollValues: function(scrollPosition) {
      ViewportMetrics.currentScrollLeft = scrollPosition.x;
      ViewportMetrics.currentScrollTop = scrollPosition.y;
    }
  };
  module.exports = ViewportMetrics;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/isEventSupported", ["npm:react@0.13.3/lib/ExecutionEnvironment"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
  var useHasFeature;
  if (ExecutionEnvironment.canUseDOM) {
    useHasFeature = document.implementation && document.implementation.hasFeature && document.implementation.hasFeature('', '') !== true;
  }
  function isEventSupported(eventNameSuffix, capture) {
    if (!ExecutionEnvironment.canUseDOM || capture && !('addEventListener' in document)) {
      return false;
    }
    var eventName = 'on' + eventNameSuffix;
    var isSupported = eventName in document;
    if (!isSupported) {
      var element = document.createElement('div');
      element.setAttribute(eventName, 'return;');
      isSupported = typeof element[eventName] === 'function';
    }
    if (!isSupported && useHasFeature && eventNameSuffix === 'wheel') {
      isSupported = document.implementation.hasFeature('Events.wheel', '3.0');
    }
    return isSupported;
  }
  module.exports = isEventSupported;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactEmptyComponent", ["npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactInstanceMap", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactInstanceMap = require("npm:react@0.13.3/lib/ReactInstanceMap");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var component;
    var nullComponentIDsRegistry = {};
    var ReactEmptyComponentInjection = {injectEmptyComponent: function(emptyComponent) {
        component = ReactElement.createFactory(emptyComponent);
      }};
    var ReactEmptyComponentType = function() {};
    ReactEmptyComponentType.prototype.componentDidMount = function() {
      var internalInstance = ReactInstanceMap.get(this);
      if (!internalInstance) {
        return ;
      }
      registerNullComponentID(internalInstance._rootNodeID);
    };
    ReactEmptyComponentType.prototype.componentWillUnmount = function() {
      var internalInstance = ReactInstanceMap.get(this);
      if (!internalInstance) {
        return ;
      }
      deregisterNullComponentID(internalInstance._rootNodeID);
    };
    ReactEmptyComponentType.prototype.render = function() {
      ("production" !== process.env.NODE_ENV ? invariant(component, 'Trying to return null from a render, but no null placeholder component ' + 'was injected.') : invariant(component));
      return component();
    };
    var emptyElement = ReactElement.createElement(ReactEmptyComponentType);
    function registerNullComponentID(id) {
      nullComponentIDsRegistry[id] = true;
    }
    function deregisterNullComponentID(id) {
      delete nullComponentIDsRegistry[id];
    }
    function isNullComponentID(id) {
      return !!nullComponentIDsRegistry[id];
    }
    var ReactEmptyComponent = {
      emptyElement: emptyElement,
      injection: ReactEmptyComponentInjection,
      isNullComponentID: isNullComponentID
    };
    module.exports = ReactEmptyComponent;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/adler32", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var MOD = 65521;
  function adler32(data) {
    var a = 1;
    var b = 0;
    for (var i = 0; i < data.length; i++) {
      a = (a + data.charCodeAt(i)) % MOD;
      b = (b + a) % MOD;
    }
    return a | (b << 16);
  }
  module.exports = adler32;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/isNode", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function isNode(object) {
    return !!(object && (((typeof Node === 'function' ? object instanceof Node : typeof object === 'object' && typeof object.nodeType === 'number' && typeof object.nodeName === 'string'))));
  }
  module.exports = isNode;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/getReactRootElementInContainer", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var DOC_NODE_TYPE = 9;
  function getReactRootElementInContainer(container) {
    if (!container) {
      return null;
    }
    if (container.nodeType === DOC_NODE_TYPE) {
      return container.documentElement;
    } else {
      return container.firstChild;
    }
  }
  module.exports = getReactRootElementInContainer;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactComponentEnvironment", ["npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var injected = false;
    var ReactComponentEnvironment = {
      unmountIDFromEnvironment: null,
      replaceNodeWithMarkupByID: null,
      processChildrenUpdates: null,
      injection: {injectEnvironment: function(environment) {
          ("production" !== process.env.NODE_ENV ? invariant(!injected, 'ReactCompositeComponent: injectEnvironment() can only be called once.') : invariant(!injected));
          ReactComponentEnvironment.unmountIDFromEnvironment = environment.unmountIDFromEnvironment;
          ReactComponentEnvironment.replaceNodeWithMarkupByID = environment.replaceNodeWithMarkupByID;
          ReactComponentEnvironment.processChildrenUpdates = environment.processChildrenUpdates;
          injected = true;
        }}
    };
    module.exports = ReactComponentEnvironment;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/shouldUpdateReactComponent", ["npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var warning = require("npm:react@0.13.3/lib/warning");
    function shouldUpdateReactComponent(prevElement, nextElement) {
      if (prevElement != null && nextElement != null) {
        var prevType = typeof prevElement;
        var nextType = typeof nextElement;
        if (prevType === 'string' || prevType === 'number') {
          return (nextType === 'string' || nextType === 'number');
        } else {
          if (nextType === 'object' && prevElement.type === nextElement.type && prevElement.key === nextElement.key) {
            var ownersMatch = prevElement._owner === nextElement._owner;
            var prevName = null;
            var nextName = null;
            var nextDisplayName = null;
            if ("production" !== process.env.NODE_ENV) {
              if (!ownersMatch) {
                if (prevElement._owner != null && prevElement._owner.getPublicInstance() != null && prevElement._owner.getPublicInstance().constructor != null) {
                  prevName = prevElement._owner.getPublicInstance().constructor.displayName;
                }
                if (nextElement._owner != null && nextElement._owner.getPublicInstance() != null && nextElement._owner.getPublicInstance().constructor != null) {
                  nextName = nextElement._owner.getPublicInstance().constructor.displayName;
                }
                if (nextElement.type != null && nextElement.type.displayName != null) {
                  nextDisplayName = nextElement.type.displayName;
                }
                if (nextElement.type != null && typeof nextElement.type === 'string') {
                  nextDisplayName = nextElement.type;
                }
                if (typeof nextElement.type !== 'string' || nextElement.type === 'input' || nextElement.type === 'textarea') {
                  if ((prevElement._owner != null && prevElement._owner._isOwnerNecessary === false) || (nextElement._owner != null && nextElement._owner._isOwnerNecessary === false)) {
                    if (prevElement._owner != null) {
                      prevElement._owner._isOwnerNecessary = true;
                    }
                    if (nextElement._owner != null) {
                      nextElement._owner._isOwnerNecessary = true;
                    }
                    ("production" !== process.env.NODE_ENV ? warning(false, '<%s /> is being rendered by both %s and %s using the same ' + 'key (%s) in the same place. Currently, this means that ' + 'they don\'t preserve state. This behavior should be very ' + 'rare so we\'re considering deprecating it. Please contact ' + 'the React team and explain your use case so that we can ' + 'take that into consideration.', nextDisplayName || 'Unknown Component', prevName || '[Unknown]', nextName || '[Unknown]', prevElement.key) : null);
                  }
                }
              }
            }
            return ownersMatch;
          }
        }
      }
      return false;
    }
    module.exports = shouldUpdateReactComponent;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/flattenChildren", ["npm:react@0.13.3/lib/traverseAllChildren", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var traverseAllChildren = require("npm:react@0.13.3/lib/traverseAllChildren");
    var warning = require("npm:react@0.13.3/lib/warning");
    function flattenSingleChildIntoContext(traverseContext, child, name) {
      var result = traverseContext;
      var keyUnique = !result.hasOwnProperty(name);
      if ("production" !== process.env.NODE_ENV) {
        ("production" !== process.env.NODE_ENV ? warning(keyUnique, 'flattenChildren(...): Encountered two children with the same key, ' + '`%s`. Child keys must be unique; when two children share a key, only ' + 'the first child will be used.', name) : null);
      }
      if (keyUnique && child != null) {
        result[name] = child;
      }
    }
    function flattenChildren(children) {
      if (children == null) {
        return children;
      }
      var result = {};
      traverseAllChildren(children, flattenSingleChildIntoContext, result);
      return result;
    }
    module.exports = flattenChildren;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/EventPropagators", ["npm:react@0.13.3/lib/EventConstants", "npm:react@0.13.3/lib/EventPluginHub", "npm:react@0.13.3/lib/accumulateInto", "npm:react@0.13.3/lib/forEachAccumulated", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var EventConstants = require("npm:react@0.13.3/lib/EventConstants");
    var EventPluginHub = require("npm:react@0.13.3/lib/EventPluginHub");
    var accumulateInto = require("npm:react@0.13.3/lib/accumulateInto");
    var forEachAccumulated = require("npm:react@0.13.3/lib/forEachAccumulated");
    var PropagationPhases = EventConstants.PropagationPhases;
    var getListener = EventPluginHub.getListener;
    function listenerAtPhase(id, event, propagationPhase) {
      var registrationName = event.dispatchConfig.phasedRegistrationNames[propagationPhase];
      return getListener(id, registrationName);
    }
    function accumulateDirectionalDispatches(domID, upwards, event) {
      if ("production" !== process.env.NODE_ENV) {
        if (!domID) {
          throw new Error('Dispatching id must not be null');
        }
      }
      var phase = upwards ? PropagationPhases.bubbled : PropagationPhases.captured;
      var listener = listenerAtPhase(domID, event, phase);
      if (listener) {
        event._dispatchListeners = accumulateInto(event._dispatchListeners, listener);
        event._dispatchIDs = accumulateInto(event._dispatchIDs, domID);
      }
    }
    function accumulateTwoPhaseDispatchesSingle(event) {
      if (event && event.dispatchConfig.phasedRegistrationNames) {
        EventPluginHub.injection.getInstanceHandle().traverseTwoPhase(event.dispatchMarker, accumulateDirectionalDispatches, event);
      }
    }
    function accumulateDispatches(id, ignoredDirection, event) {
      if (event && event.dispatchConfig.registrationName) {
        var registrationName = event.dispatchConfig.registrationName;
        var listener = getListener(id, registrationName);
        if (listener) {
          event._dispatchListeners = accumulateInto(event._dispatchListeners, listener);
          event._dispatchIDs = accumulateInto(event._dispatchIDs, id);
        }
      }
    }
    function accumulateDirectDispatchesSingle(event) {
      if (event && event.dispatchConfig.registrationName) {
        accumulateDispatches(event.dispatchMarker, null, event);
      }
    }
    function accumulateTwoPhaseDispatches(events) {
      forEachAccumulated(events, accumulateTwoPhaseDispatchesSingle);
    }
    function accumulateEnterLeaveDispatches(leave, enter, fromID, toID) {
      EventPluginHub.injection.getInstanceHandle().traverseEnterLeave(fromID, toID, accumulateDispatches, leave, enter);
    }
    function accumulateDirectDispatches(events) {
      forEachAccumulated(events, accumulateDirectDispatchesSingle);
    }
    var EventPropagators = {
      accumulateTwoPhaseDispatches: accumulateTwoPhaseDispatches,
      accumulateDirectDispatches: accumulateDirectDispatches,
      accumulateEnterLeaveDispatches: accumulateEnterLeaveDispatches
    };
    module.exports = EventPropagators;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/getTextContentAccessor", ["npm:react@0.13.3/lib/ExecutionEnvironment"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
  var contentKey = null;
  function getTextContentAccessor() {
    if (!contentKey && ExecutionEnvironment.canUseDOM) {
      contentKey = 'textContent' in document.documentElement ? 'textContent' : 'innerText';
    }
    return contentKey;
  }
  module.exports = getTextContentAccessor;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/getEventTarget", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  function getEventTarget(nativeEvent) {
    var target = nativeEvent.target || nativeEvent.srcElement || window;
    return target.nodeType === 3 ? target.parentNode : target;
  }
  module.exports = getEventTarget;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SyntheticInputEvent", ["npm:react@0.13.3/lib/SyntheticEvent"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var SyntheticEvent = require("npm:react@0.13.3/lib/SyntheticEvent");
  var InputEventInterface = {data: null};
  function SyntheticInputEvent(dispatchConfig, dispatchMarker, nativeEvent) {
    SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
  }
  SyntheticEvent.augmentClass(SyntheticInputEvent, InputEventInterface);
  module.exports = SyntheticInputEvent;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/isTextInputElement", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var supportedInputTypes = {
    'color': true,
    'date': true,
    'datetime': true,
    'datetime-local': true,
    'email': true,
    'month': true,
    'number': true,
    'password': true,
    'range': true,
    'search': true,
    'tel': true,
    'text': true,
    'time': true,
    'url': true,
    'week': true
  };
  function isTextInputElement(elem) {
    return elem && ((elem.nodeName === 'INPUT' && supportedInputTypes[elem.type] || elem.nodeName === 'TEXTAREA'));
  }
  module.exports = isTextInputElement;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ClientReactRootIndex", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var nextReactRootIndex = 0;
  var ClientReactRootIndex = {createReactRootIndex: function() {
      return nextReactRootIndex++;
    }};
  module.exports = ClientReactRootIndex;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/DefaultEventPluginOrder", ["npm:react@0.13.3/lib/keyOf"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var keyOf = require("npm:react@0.13.3/lib/keyOf");
  var DefaultEventPluginOrder = [keyOf({ResponderEventPlugin: null}), keyOf({SimpleEventPlugin: null}), keyOf({TapEventPlugin: null}), keyOf({EnterLeaveEventPlugin: null}), keyOf({ChangeEventPlugin: null}), keyOf({SelectEventPlugin: null}), keyOf({BeforeInputEventPlugin: null}), keyOf({AnalyticsEventPlugin: null}), keyOf({MobileSafariClickEventPlugin: null})];
  module.exports = DefaultEventPluginOrder;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SyntheticUIEvent", ["npm:react@0.13.3/lib/SyntheticEvent", "npm:react@0.13.3/lib/getEventTarget"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var SyntheticEvent = require("npm:react@0.13.3/lib/SyntheticEvent");
  var getEventTarget = require("npm:react@0.13.3/lib/getEventTarget");
  var UIEventInterface = {
    view: function(event) {
      if (event.view) {
        return event.view;
      }
      var target = getEventTarget(event);
      if (target != null && target.window === target) {
        return target;
      }
      var doc = target.ownerDocument;
      if (doc) {
        return doc.defaultView || doc.parentWindow;
      } else {
        return window;
      }
    },
    detail: function(event) {
      return event.detail || 0;
    }
  };
  function SyntheticUIEvent(dispatchConfig, dispatchMarker, nativeEvent) {
    SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
  }
  SyntheticEvent.augmentClass(SyntheticUIEvent, UIEventInterface);
  module.exports = SyntheticUIEvent;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/getEventModifierState", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var modifierKeyToProp = {
    'Alt': 'altKey',
    'Control': 'ctrlKey',
    'Meta': 'metaKey',
    'Shift': 'shiftKey'
  };
  function modifierStateGetter(keyArg) {
    var syntheticEvent = this;
    var nativeEvent = syntheticEvent.nativeEvent;
    if (nativeEvent.getModifierState) {
      return nativeEvent.getModifierState(keyArg);
    }
    var keyProp = modifierKeyToProp[keyArg];
    return keyProp ? !!nativeEvent[keyProp] : false;
  }
  function getEventModifierState(nativeEvent) {
    return modifierStateGetter;
  }
  module.exports = getEventModifierState;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/HTMLDOMPropertyConfig", ["npm:react@0.13.3/lib/DOMProperty", "npm:react@0.13.3/lib/ExecutionEnvironment"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var DOMProperty = require("npm:react@0.13.3/lib/DOMProperty");
  var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
  var MUST_USE_ATTRIBUTE = DOMProperty.injection.MUST_USE_ATTRIBUTE;
  var MUST_USE_PROPERTY = DOMProperty.injection.MUST_USE_PROPERTY;
  var HAS_BOOLEAN_VALUE = DOMProperty.injection.HAS_BOOLEAN_VALUE;
  var HAS_SIDE_EFFECTS = DOMProperty.injection.HAS_SIDE_EFFECTS;
  var HAS_NUMERIC_VALUE = DOMProperty.injection.HAS_NUMERIC_VALUE;
  var HAS_POSITIVE_NUMERIC_VALUE = DOMProperty.injection.HAS_POSITIVE_NUMERIC_VALUE;
  var HAS_OVERLOADED_BOOLEAN_VALUE = DOMProperty.injection.HAS_OVERLOADED_BOOLEAN_VALUE;
  var hasSVG;
  if (ExecutionEnvironment.canUseDOM) {
    var implementation = document.implementation;
    hasSVG = (implementation && implementation.hasFeature && implementation.hasFeature('http://www.w3.org/TR/SVG11/feature#BasicStructure', '1.1'));
  }
  var HTMLDOMPropertyConfig = {
    isCustomAttribute: RegExp.prototype.test.bind(/^(data|aria)-[a-z_][a-z\d_.\-]*$/),
    Properties: {
      accept: null,
      acceptCharset: null,
      accessKey: null,
      action: null,
      allowFullScreen: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
      allowTransparency: MUST_USE_ATTRIBUTE,
      alt: null,
      async: HAS_BOOLEAN_VALUE,
      autoComplete: null,
      autoPlay: HAS_BOOLEAN_VALUE,
      cellPadding: null,
      cellSpacing: null,
      charSet: MUST_USE_ATTRIBUTE,
      checked: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
      classID: MUST_USE_ATTRIBUTE,
      className: hasSVG ? MUST_USE_ATTRIBUTE : MUST_USE_PROPERTY,
      cols: MUST_USE_ATTRIBUTE | HAS_POSITIVE_NUMERIC_VALUE,
      colSpan: null,
      content: null,
      contentEditable: null,
      contextMenu: MUST_USE_ATTRIBUTE,
      controls: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
      coords: null,
      crossOrigin: null,
      data: null,
      dateTime: MUST_USE_ATTRIBUTE,
      defer: HAS_BOOLEAN_VALUE,
      dir: null,
      disabled: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
      download: HAS_OVERLOADED_BOOLEAN_VALUE,
      draggable: null,
      encType: null,
      form: MUST_USE_ATTRIBUTE,
      formAction: MUST_USE_ATTRIBUTE,
      formEncType: MUST_USE_ATTRIBUTE,
      formMethod: MUST_USE_ATTRIBUTE,
      formNoValidate: HAS_BOOLEAN_VALUE,
      formTarget: MUST_USE_ATTRIBUTE,
      frameBorder: MUST_USE_ATTRIBUTE,
      headers: null,
      height: MUST_USE_ATTRIBUTE,
      hidden: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
      high: null,
      href: null,
      hrefLang: null,
      htmlFor: null,
      httpEquiv: null,
      icon: null,
      id: MUST_USE_PROPERTY,
      label: null,
      lang: null,
      list: MUST_USE_ATTRIBUTE,
      loop: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
      low: null,
      manifest: MUST_USE_ATTRIBUTE,
      marginHeight: null,
      marginWidth: null,
      max: null,
      maxLength: MUST_USE_ATTRIBUTE,
      media: MUST_USE_ATTRIBUTE,
      mediaGroup: null,
      method: null,
      min: null,
      multiple: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
      muted: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
      name: null,
      noValidate: HAS_BOOLEAN_VALUE,
      open: HAS_BOOLEAN_VALUE,
      optimum: null,
      pattern: null,
      placeholder: null,
      poster: null,
      preload: null,
      radioGroup: null,
      readOnly: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
      rel: null,
      required: HAS_BOOLEAN_VALUE,
      role: MUST_USE_ATTRIBUTE,
      rows: MUST_USE_ATTRIBUTE | HAS_POSITIVE_NUMERIC_VALUE,
      rowSpan: null,
      sandbox: null,
      scope: null,
      scoped: HAS_BOOLEAN_VALUE,
      scrolling: null,
      seamless: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
      selected: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
      shape: null,
      size: MUST_USE_ATTRIBUTE | HAS_POSITIVE_NUMERIC_VALUE,
      sizes: MUST_USE_ATTRIBUTE,
      span: HAS_POSITIVE_NUMERIC_VALUE,
      spellCheck: null,
      src: null,
      srcDoc: MUST_USE_PROPERTY,
      srcSet: MUST_USE_ATTRIBUTE,
      start: HAS_NUMERIC_VALUE,
      step: null,
      style: null,
      tabIndex: null,
      target: null,
      title: null,
      type: null,
      useMap: null,
      value: MUST_USE_PROPERTY | HAS_SIDE_EFFECTS,
      width: MUST_USE_ATTRIBUTE,
      wmode: MUST_USE_ATTRIBUTE,
      autoCapitalize: null,
      autoCorrect: null,
      itemProp: MUST_USE_ATTRIBUTE,
      itemScope: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
      itemType: MUST_USE_ATTRIBUTE,
      itemID: MUST_USE_ATTRIBUTE,
      itemRef: MUST_USE_ATTRIBUTE,
      property: null,
      unselectable: MUST_USE_ATTRIBUTE
    },
    DOMAttributeNames: {
      acceptCharset: 'accept-charset',
      className: 'class',
      htmlFor: 'for',
      httpEquiv: 'http-equiv'
    },
    DOMPropertyNames: {
      autoCapitalize: 'autocapitalize',
      autoComplete: 'autocomplete',
      autoCorrect: 'autocorrect',
      autoFocus: 'autofocus',
      autoPlay: 'autoplay',
      encType: 'encoding',
      hrefLang: 'hreflang',
      radioGroup: 'radiogroup',
      spellCheck: 'spellcheck',
      srcDoc: 'srcdoc',
      srcSet: 'srcset'
    }
  };
  module.exports = HTMLDOMPropertyConfig;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/MobileSafariClickEventPlugin", ["npm:react@0.13.3/lib/EventConstants", "npm:react@0.13.3/lib/emptyFunction"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var EventConstants = require("npm:react@0.13.3/lib/EventConstants");
  var emptyFunction = require("npm:react@0.13.3/lib/emptyFunction");
  var topLevelTypes = EventConstants.topLevelTypes;
  var MobileSafariClickEventPlugin = {
    eventTypes: null,
    extractEvents: function(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent) {
      if (topLevelType === topLevelTypes.topTouchStart) {
        var target = nativeEvent.target;
        if (target && !target.onclick) {
          target.onclick = emptyFunction;
        }
      }
    }
  };
  module.exports = MobileSafariClickEventPlugin;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/findDOMNode", ["npm:react@0.13.3/lib/ReactCurrentOwner", "npm:react@0.13.3/lib/ReactInstanceMap", "npm:react@0.13.3/lib/ReactMount", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/isNode", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactCurrentOwner = require("npm:react@0.13.3/lib/ReactCurrentOwner");
    var ReactInstanceMap = require("npm:react@0.13.3/lib/ReactInstanceMap");
    var ReactMount = require("npm:react@0.13.3/lib/ReactMount");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var isNode = require("npm:react@0.13.3/lib/isNode");
    var warning = require("npm:react@0.13.3/lib/warning");
    function findDOMNode(componentOrElement) {
      if ("production" !== process.env.NODE_ENV) {
        var owner = ReactCurrentOwner.current;
        if (owner !== null) {
          ("production" !== process.env.NODE_ENV ? warning(owner._warnedAboutRefsInRender, '%s is accessing getDOMNode or findDOMNode inside its render(). ' + 'render() should be a pure function of props and state. It should ' + 'never access something that requires stale data from the previous ' + 'render, such as refs. Move this logic to componentDidMount and ' + 'componentDidUpdate instead.', owner.getName() || 'A component') : null);
          owner._warnedAboutRefsInRender = true;
        }
      }
      if (componentOrElement == null) {
        return null;
      }
      if (isNode(componentOrElement)) {
        return componentOrElement;
      }
      if (ReactInstanceMap.has(componentOrElement)) {
        return ReactMount.getNodeFromInstance(componentOrElement);
      }
      ("production" !== process.env.NODE_ENV ? invariant(componentOrElement.render == null || typeof componentOrElement.render !== 'function', 'Component (with keys: %s) contains `render` method ' + 'but is not mounted in the DOM', Object.keys(componentOrElement)) : invariant(componentOrElement.render == null || typeof componentOrElement.render !== 'function'));
      ("production" !== process.env.NODE_ENV ? invariant(false, 'Element appears to be neither ReactComponent nor DOMNode (keys: %s)', Object.keys(componentOrElement)) : invariant(false));
    }
    module.exports = findDOMNode;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDefaultBatchingStrategy", ["npm:react@0.13.3/lib/ReactUpdates", "npm:react@0.13.3/lib/Transaction", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/emptyFunction"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ReactUpdates = require("npm:react@0.13.3/lib/ReactUpdates");
  var Transaction = require("npm:react@0.13.3/lib/Transaction");
  var assign = require("npm:react@0.13.3/lib/Object.assign");
  var emptyFunction = require("npm:react@0.13.3/lib/emptyFunction");
  var RESET_BATCHED_UPDATES = {
    initialize: emptyFunction,
    close: function() {
      ReactDefaultBatchingStrategy.isBatchingUpdates = false;
    }
  };
  var FLUSH_BATCHED_UPDATES = {
    initialize: emptyFunction,
    close: ReactUpdates.flushBatchedUpdates.bind(ReactUpdates)
  };
  var TRANSACTION_WRAPPERS = [FLUSH_BATCHED_UPDATES, RESET_BATCHED_UPDATES];
  function ReactDefaultBatchingStrategyTransaction() {
    this.reinitializeTransaction();
  }
  assign(ReactDefaultBatchingStrategyTransaction.prototype, Transaction.Mixin, {getTransactionWrappers: function() {
      return TRANSACTION_WRAPPERS;
    }});
  var transaction = new ReactDefaultBatchingStrategyTransaction();
  var ReactDefaultBatchingStrategy = {
    isBatchingUpdates: false,
    batchedUpdates: function(callback, a, b, c, d) {
      var alreadyBatchingUpdates = ReactDefaultBatchingStrategy.isBatchingUpdates;
      ReactDefaultBatchingStrategy.isBatchingUpdates = true;
      if (alreadyBatchingUpdates) {
        callback(a, b, c, d);
      } else {
        transaction.perform(callback, null, a, b, c, d);
      }
    }
  };
  module.exports = ReactDefaultBatchingStrategy;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/focusNode", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  function focusNode(node) {
    try {
      node.focus();
    } catch (e) {}
  }
  module.exports = focusNode;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/LocalEventTrapMixin", ["npm:react@0.13.3/lib/ReactBrowserEventEmitter", "npm:react@0.13.3/lib/accumulateInto", "npm:react@0.13.3/lib/forEachAccumulated", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactBrowserEventEmitter = require("npm:react@0.13.3/lib/ReactBrowserEventEmitter");
    var accumulateInto = require("npm:react@0.13.3/lib/accumulateInto");
    var forEachAccumulated = require("npm:react@0.13.3/lib/forEachAccumulated");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    function remove(event) {
      event.remove();
    }
    var LocalEventTrapMixin = {
      trapBubbledEvent: function(topLevelType, handlerBaseName) {
        ("production" !== process.env.NODE_ENV ? invariant(this.isMounted(), 'Must be mounted to trap events') : invariant(this.isMounted()));
        var node = this.getDOMNode();
        ("production" !== process.env.NODE_ENV ? invariant(node, 'LocalEventTrapMixin.trapBubbledEvent(...): Requires node to be rendered.') : invariant(node));
        var listener = ReactBrowserEventEmitter.trapBubbledEvent(topLevelType, handlerBaseName, node);
        this._localEventListeners = accumulateInto(this._localEventListeners, listener);
      },
      componentWillUnmount: function() {
        if (this._localEventListeners) {
          forEachAccumulated(this._localEventListeners, remove);
        }
      }
    };
    module.exports = LocalEventTrapMixin;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOMImg", ["npm:react@0.13.3/lib/EventConstants", "npm:react@0.13.3/lib/LocalEventTrapMixin", "npm:react@0.13.3/lib/ReactBrowserComponentMixin", "npm:react@0.13.3/lib/ReactClass", "npm:react@0.13.3/lib/ReactElement"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var EventConstants = require("npm:react@0.13.3/lib/EventConstants");
  var LocalEventTrapMixin = require("npm:react@0.13.3/lib/LocalEventTrapMixin");
  var ReactBrowserComponentMixin = require("npm:react@0.13.3/lib/ReactBrowserComponentMixin");
  var ReactClass = require("npm:react@0.13.3/lib/ReactClass");
  var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
  var img = ReactElement.createFactory('img');
  var ReactDOMImg = ReactClass.createClass({
    displayName: 'ReactDOMImg',
    tagName: 'IMG',
    mixins: [ReactBrowserComponentMixin, LocalEventTrapMixin],
    render: function() {
      return img(this.props);
    },
    componentDidMount: function() {
      this.trapBubbledEvent(EventConstants.topLevelTypes.topLoad, 'load');
      this.trapBubbledEvent(EventConstants.topLevelTypes.topError, 'error');
    }
  });
  module.exports = ReactDOMImg;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOMIframe", ["npm:react@0.13.3/lib/EventConstants", "npm:react@0.13.3/lib/LocalEventTrapMixin", "npm:react@0.13.3/lib/ReactBrowserComponentMixin", "npm:react@0.13.3/lib/ReactClass", "npm:react@0.13.3/lib/ReactElement"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var EventConstants = require("npm:react@0.13.3/lib/EventConstants");
  var LocalEventTrapMixin = require("npm:react@0.13.3/lib/LocalEventTrapMixin");
  var ReactBrowserComponentMixin = require("npm:react@0.13.3/lib/ReactBrowserComponentMixin");
  var ReactClass = require("npm:react@0.13.3/lib/ReactClass");
  var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
  var iframe = ReactElement.createFactory('iframe');
  var ReactDOMIframe = ReactClass.createClass({
    displayName: 'ReactDOMIframe',
    tagName: 'IFRAME',
    mixins: [ReactBrowserComponentMixin, LocalEventTrapMixin],
    render: function() {
      return iframe(this.props);
    },
    componentDidMount: function() {
      this.trapBubbledEvent(EventConstants.topLevelTypes.topLoad, 'load');
    }
  });
  module.exports = ReactDOMIframe;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactPropTypes", ["npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactFragment", "npm:react@0.13.3/lib/ReactPropTypeLocationNames", "npm:react@0.13.3/lib/emptyFunction"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
  var ReactFragment = require("npm:react@0.13.3/lib/ReactFragment");
  var ReactPropTypeLocationNames = require("npm:react@0.13.3/lib/ReactPropTypeLocationNames");
  var emptyFunction = require("npm:react@0.13.3/lib/emptyFunction");
  var ANONYMOUS = '<<anonymous>>';
  var elementTypeChecker = createElementTypeChecker();
  var nodeTypeChecker = createNodeChecker();
  var ReactPropTypes = {
    array: createPrimitiveTypeChecker('array'),
    bool: createPrimitiveTypeChecker('boolean'),
    func: createPrimitiveTypeChecker('function'),
    number: createPrimitiveTypeChecker('number'),
    object: createPrimitiveTypeChecker('object'),
    string: createPrimitiveTypeChecker('string'),
    any: createAnyTypeChecker(),
    arrayOf: createArrayOfTypeChecker,
    element: elementTypeChecker,
    instanceOf: createInstanceTypeChecker,
    node: nodeTypeChecker,
    objectOf: createObjectOfTypeChecker,
    oneOf: createEnumTypeChecker,
    oneOfType: createUnionTypeChecker,
    shape: createShapeTypeChecker
  };
  function createChainableTypeChecker(validate) {
    function checkType(isRequired, props, propName, componentName, location) {
      componentName = componentName || ANONYMOUS;
      if (props[propName] == null) {
        var locationName = ReactPropTypeLocationNames[location];
        if (isRequired) {
          return new Error(("Required " + locationName + " `" + propName + "` was not specified in ") + ("`" + componentName + "`."));
        }
        return null;
      } else {
        return validate(props, propName, componentName, location);
      }
    }
    var chainedCheckType = checkType.bind(null, false);
    chainedCheckType.isRequired = checkType.bind(null, true);
    return chainedCheckType;
  }
  function createPrimitiveTypeChecker(expectedType) {
    function validate(props, propName, componentName, location) {
      var propValue = props[propName];
      var propType = getPropType(propValue);
      if (propType !== expectedType) {
        var locationName = ReactPropTypeLocationNames[location];
        var preciseType = getPreciseType(propValue);
        return new Error(("Invalid " + locationName + " `" + propName + "` of type `" + preciseType + "` ") + ("supplied to `" + componentName + "`, expected `" + expectedType + "`."));
      }
      return null;
    }
    return createChainableTypeChecker(validate);
  }
  function createAnyTypeChecker() {
    return createChainableTypeChecker(emptyFunction.thatReturns(null));
  }
  function createArrayOfTypeChecker(typeChecker) {
    function validate(props, propName, componentName, location) {
      var propValue = props[propName];
      if (!Array.isArray(propValue)) {
        var locationName = ReactPropTypeLocationNames[location];
        var propType = getPropType(propValue);
        return new Error(("Invalid " + locationName + " `" + propName + "` of type ") + ("`" + propType + "` supplied to `" + componentName + "`, expected an array."));
      }
      for (var i = 0; i < propValue.length; i++) {
        var error = typeChecker(propValue, i, componentName, location);
        if (error instanceof Error) {
          return error;
        }
      }
      return null;
    }
    return createChainableTypeChecker(validate);
  }
  function createElementTypeChecker() {
    function validate(props, propName, componentName, location) {
      if (!ReactElement.isValidElement(props[propName])) {
        var locationName = ReactPropTypeLocationNames[location];
        return new Error(("Invalid " + locationName + " `" + propName + "` supplied to ") + ("`" + componentName + "`, expected a ReactElement."));
      }
      return null;
    }
    return createChainableTypeChecker(validate);
  }
  function createInstanceTypeChecker(expectedClass) {
    function validate(props, propName, componentName, location) {
      if (!(props[propName] instanceof expectedClass)) {
        var locationName = ReactPropTypeLocationNames[location];
        var expectedClassName = expectedClass.name || ANONYMOUS;
        return new Error(("Invalid " + locationName + " `" + propName + "` supplied to ") + ("`" + componentName + "`, expected instance of `" + expectedClassName + "`."));
      }
      return null;
    }
    return createChainableTypeChecker(validate);
  }
  function createEnumTypeChecker(expectedValues) {
    function validate(props, propName, componentName, location) {
      var propValue = props[propName];
      for (var i = 0; i < expectedValues.length; i++) {
        if (propValue === expectedValues[i]) {
          return null;
        }
      }
      var locationName = ReactPropTypeLocationNames[location];
      var valuesString = JSON.stringify(expectedValues);
      return new Error(("Invalid " + locationName + " `" + propName + "` of value `" + propValue + "` ") + ("supplied to `" + componentName + "`, expected one of " + valuesString + "."));
    }
    return createChainableTypeChecker(validate);
  }
  function createObjectOfTypeChecker(typeChecker) {
    function validate(props, propName, componentName, location) {
      var propValue = props[propName];
      var propType = getPropType(propValue);
      if (propType !== 'object') {
        var locationName = ReactPropTypeLocationNames[location];
        return new Error(("Invalid " + locationName + " `" + propName + "` of type ") + ("`" + propType + "` supplied to `" + componentName + "`, expected an object."));
      }
      for (var key in propValue) {
        if (propValue.hasOwnProperty(key)) {
          var error = typeChecker(propValue, key, componentName, location);
          if (error instanceof Error) {
            return error;
          }
        }
      }
      return null;
    }
    return createChainableTypeChecker(validate);
  }
  function createUnionTypeChecker(arrayOfTypeCheckers) {
    function validate(props, propName, componentName, location) {
      for (var i = 0; i < arrayOfTypeCheckers.length; i++) {
        var checker = arrayOfTypeCheckers[i];
        if (checker(props, propName, componentName, location) == null) {
          return null;
        }
      }
      var locationName = ReactPropTypeLocationNames[location];
      return new Error(("Invalid " + locationName + " `" + propName + "` supplied to ") + ("`" + componentName + "`."));
    }
    return createChainableTypeChecker(validate);
  }
  function createNodeChecker() {
    function validate(props, propName, componentName, location) {
      if (!isNode(props[propName])) {
        var locationName = ReactPropTypeLocationNames[location];
        return new Error(("Invalid " + locationName + " `" + propName + "` supplied to ") + ("`" + componentName + "`, expected a ReactNode."));
      }
      return null;
    }
    return createChainableTypeChecker(validate);
  }
  function createShapeTypeChecker(shapeTypes) {
    function validate(props, propName, componentName, location) {
      var propValue = props[propName];
      var propType = getPropType(propValue);
      if (propType !== 'object') {
        var locationName = ReactPropTypeLocationNames[location];
        return new Error(("Invalid " + locationName + " `" + propName + "` of type `" + propType + "` ") + ("supplied to `" + componentName + "`, expected `object`."));
      }
      for (var key in shapeTypes) {
        var checker = shapeTypes[key];
        if (!checker) {
          continue;
        }
        var error = checker(propValue, key, componentName, location);
        if (error) {
          return error;
        }
      }
      return null;
    }
    return createChainableTypeChecker(validate);
  }
  function isNode(propValue) {
    switch (typeof propValue) {
      case 'number':
      case 'string':
      case 'undefined':
        return true;
      case 'boolean':
        return !propValue;
      case 'object':
        if (Array.isArray(propValue)) {
          return propValue.every(isNode);
        }
        if (propValue === null || ReactElement.isValidElement(propValue)) {
          return true;
        }
        propValue = ReactFragment.extractIfFragment(propValue);
        for (var k in propValue) {
          if (!isNode(propValue[k])) {
            return false;
          }
        }
        return true;
      default:
        return false;
    }
  }
  function getPropType(propValue) {
    var propType = typeof propValue;
    if (Array.isArray(propValue)) {
      return 'array';
    }
    if (propValue instanceof RegExp) {
      return 'object';
    }
    return propType;
  }
  function getPreciseType(propValue) {
    var propType = getPropType(propValue);
    if (propType === 'object') {
      if (propValue instanceof Date) {
        return 'date';
      } else if (propValue instanceof RegExp) {
        return 'regexp';
      }
    }
    return propType;
  }
  module.exports = ReactPropTypes;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOMOption", ["npm:react@0.13.3/lib/ReactBrowserComponentMixin", "npm:react@0.13.3/lib/ReactClass", "npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactBrowserComponentMixin = require("npm:react@0.13.3/lib/ReactBrowserComponentMixin");
    var ReactClass = require("npm:react@0.13.3/lib/ReactClass");
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var warning = require("npm:react@0.13.3/lib/warning");
    var option = ReactElement.createFactory('option');
    var ReactDOMOption = ReactClass.createClass({
      displayName: 'ReactDOMOption',
      tagName: 'OPTION',
      mixins: [ReactBrowserComponentMixin],
      componentWillMount: function() {
        if ("production" !== process.env.NODE_ENV) {
          ("production" !== process.env.NODE_ENV ? warning(this.props.selected == null, 'Use the `defaultValue` or `value` props on <select> instead of ' + 'setting `selected` on <option>.') : null);
        }
      },
      render: function() {
        return option(this.props, this.props.children);
      }
    });
    module.exports = ReactDOMOption;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOMSelect", ["npm:react@0.13.3/lib/AutoFocusMixin", "npm:react@0.13.3/lib/LinkedValueUtils", "npm:react@0.13.3/lib/ReactBrowserComponentMixin", "npm:react@0.13.3/lib/ReactClass", "npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactUpdates", "npm:react@0.13.3/lib/Object.assign"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var AutoFocusMixin = require("npm:react@0.13.3/lib/AutoFocusMixin");
  var LinkedValueUtils = require("npm:react@0.13.3/lib/LinkedValueUtils");
  var ReactBrowserComponentMixin = require("npm:react@0.13.3/lib/ReactBrowserComponentMixin");
  var ReactClass = require("npm:react@0.13.3/lib/ReactClass");
  var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
  var ReactUpdates = require("npm:react@0.13.3/lib/ReactUpdates");
  var assign = require("npm:react@0.13.3/lib/Object.assign");
  var select = ReactElement.createFactory('select');
  function updateOptionsIfPendingUpdateAndMounted() {
    if (this._pendingUpdate) {
      this._pendingUpdate = false;
      var value = LinkedValueUtils.getValue(this);
      if (value != null && this.isMounted()) {
        updateOptions(this, value);
      }
    }
  }
  function selectValueType(props, propName, componentName) {
    if (props[propName] == null) {
      return null;
    }
    if (props.multiple) {
      if (!Array.isArray(props[propName])) {
        return new Error(("The `" + propName + "` prop supplied to <select> must be an array if ") + ("`multiple` is true."));
      }
    } else {
      if (Array.isArray(props[propName])) {
        return new Error(("The `" + propName + "` prop supplied to <select> must be a scalar ") + ("value if `multiple` is false."));
      }
    }
  }
  function updateOptions(component, propValue) {
    var selectedValue,
        i,
        l;
    var options = component.getDOMNode().options;
    if (component.props.multiple) {
      selectedValue = {};
      for (i = 0, l = propValue.length; i < l; i++) {
        selectedValue['' + propValue[i]] = true;
      }
      for (i = 0, l = options.length; i < l; i++) {
        var selected = selectedValue.hasOwnProperty(options[i].value);
        if (options[i].selected !== selected) {
          options[i].selected = selected;
        }
      }
    } else {
      selectedValue = '' + propValue;
      for (i = 0, l = options.length; i < l; i++) {
        if (options[i].value === selectedValue) {
          options[i].selected = true;
          return ;
        }
      }
      if (options.length) {
        options[0].selected = true;
      }
    }
  }
  var ReactDOMSelect = ReactClass.createClass({
    displayName: 'ReactDOMSelect',
    tagName: 'SELECT',
    mixins: [AutoFocusMixin, LinkedValueUtils.Mixin, ReactBrowserComponentMixin],
    propTypes: {
      defaultValue: selectValueType,
      value: selectValueType
    },
    render: function() {
      var props = assign({}, this.props);
      props.onChange = this._handleChange;
      props.value = null;
      return select(props, this.props.children);
    },
    componentWillMount: function() {
      this._pendingUpdate = false;
    },
    componentDidMount: function() {
      var value = LinkedValueUtils.getValue(this);
      if (value != null) {
        updateOptions(this, value);
      } else if (this.props.defaultValue != null) {
        updateOptions(this, this.props.defaultValue);
      }
    },
    componentDidUpdate: function(prevProps) {
      var value = LinkedValueUtils.getValue(this);
      if (value != null) {
        this._pendingUpdate = false;
        updateOptions(this, value);
      } else if (!prevProps.multiple !== !this.props.multiple) {
        if (this.props.defaultValue != null) {
          updateOptions(this, this.props.defaultValue);
        } else {
          updateOptions(this, this.props.multiple ? [] : '');
        }
      }
    },
    _handleChange: function(event) {
      var returnValue;
      var onChange = LinkedValueUtils.getOnChange(this);
      if (onChange) {
        returnValue = onChange.call(this, event);
      }
      this._pendingUpdate = true;
      ReactUpdates.asap(updateOptionsIfPendingUpdateAndMounted, this);
      return returnValue;
    }
  });
  module.exports = ReactDOMSelect;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOMTextarea", ["npm:react@0.13.3/lib/AutoFocusMixin", "npm:react@0.13.3/lib/DOMPropertyOperations", "npm:react@0.13.3/lib/LinkedValueUtils", "npm:react@0.13.3/lib/ReactBrowserComponentMixin", "npm:react@0.13.3/lib/ReactClass", "npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactUpdates", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var AutoFocusMixin = require("npm:react@0.13.3/lib/AutoFocusMixin");
    var DOMPropertyOperations = require("npm:react@0.13.3/lib/DOMPropertyOperations");
    var LinkedValueUtils = require("npm:react@0.13.3/lib/LinkedValueUtils");
    var ReactBrowserComponentMixin = require("npm:react@0.13.3/lib/ReactBrowserComponentMixin");
    var ReactClass = require("npm:react@0.13.3/lib/ReactClass");
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactUpdates = require("npm:react@0.13.3/lib/ReactUpdates");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var warning = require("npm:react@0.13.3/lib/warning");
    var textarea = ReactElement.createFactory('textarea');
    function forceUpdateIfMounted() {
      if (this.isMounted()) {
        this.forceUpdate();
      }
    }
    var ReactDOMTextarea = ReactClass.createClass({
      displayName: 'ReactDOMTextarea',
      tagName: 'TEXTAREA',
      mixins: [AutoFocusMixin, LinkedValueUtils.Mixin, ReactBrowserComponentMixin],
      getInitialState: function() {
        var defaultValue = this.props.defaultValue;
        var children = this.props.children;
        if (children != null) {
          if ("production" !== process.env.NODE_ENV) {
            ("production" !== process.env.NODE_ENV ? warning(false, 'Use the `defaultValue` or `value` props instead of setting ' + 'children on <textarea>.') : null);
          }
          ("production" !== process.env.NODE_ENV ? invariant(defaultValue == null, 'If you supply `defaultValue` on a <textarea>, do not pass children.') : invariant(defaultValue == null));
          if (Array.isArray(children)) {
            ("production" !== process.env.NODE_ENV ? invariant(children.length <= 1, '<textarea> can only have at most one child.') : invariant(children.length <= 1));
            children = children[0];
          }
          defaultValue = '' + children;
        }
        if (defaultValue == null) {
          defaultValue = '';
        }
        var value = LinkedValueUtils.getValue(this);
        return {initialValue: '' + (value != null ? value : defaultValue)};
      },
      render: function() {
        var props = assign({}, this.props);
        ("production" !== process.env.NODE_ENV ? invariant(props.dangerouslySetInnerHTML == null, '`dangerouslySetInnerHTML` does not make sense on <textarea>.') : invariant(props.dangerouslySetInnerHTML == null));
        props.defaultValue = null;
        props.value = null;
        props.onChange = this._handleChange;
        return textarea(props, this.state.initialValue);
      },
      componentDidUpdate: function(prevProps, prevState, prevContext) {
        var value = LinkedValueUtils.getValue(this);
        if (value != null) {
          var rootNode = this.getDOMNode();
          DOMPropertyOperations.setValueForProperty(rootNode, 'value', '' + value);
        }
      },
      _handleChange: function(event) {
        var returnValue;
        var onChange = LinkedValueUtils.getOnChange(this);
        if (onChange) {
          returnValue = onChange.call(this, event);
        }
        ReactUpdates.asap(forceUpdateIfMounted, this);
        return returnValue;
      }
    });
    module.exports = ReactDOMTextarea;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/EventListener", ["npm:react@0.13.3/lib/emptyFunction", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var emptyFunction = require("npm:react@0.13.3/lib/emptyFunction");
    var EventListener = {
      listen: function(target, eventType, callback) {
        if (target.addEventListener) {
          target.addEventListener(eventType, callback, false);
          return {remove: function() {
              target.removeEventListener(eventType, callback, false);
            }};
        } else if (target.attachEvent) {
          target.attachEvent('on' + eventType, callback);
          return {remove: function() {
              target.detachEvent('on' + eventType, callback);
            }};
        }
      },
      capture: function(target, eventType, callback) {
        if (!target.addEventListener) {
          if ("production" !== process.env.NODE_ENV) {
            console.error('Attempted to listen to events during the capture phase on a ' + 'browser that does not support the capture phase. Your application ' + 'will not receive some events.');
          }
          return {remove: emptyFunction};
        } else {
          target.addEventListener(eventType, callback, true);
          return {remove: function() {
              target.removeEventListener(eventType, callback, true);
            }};
        }
      },
      registerDefault: function() {}
    };
    module.exports = EventListener;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/getUnboundedScrollPosition", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  function getUnboundedScrollPosition(scrollable) {
    if (scrollable === window) {
      return {
        x: window.pageXOffset || document.documentElement.scrollLeft,
        y: window.pageYOffset || document.documentElement.scrollTop
      };
    }
    return {
      x: scrollable.scrollLeft,
      y: scrollable.scrollTop
    };
  }
  module.exports = getUnboundedScrollPosition;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactInjection", ["npm:react@0.13.3/lib/DOMProperty", "npm:react@0.13.3/lib/EventPluginHub", "npm:react@0.13.3/lib/ReactComponentEnvironment", "npm:react@0.13.3/lib/ReactClass", "npm:react@0.13.3/lib/ReactEmptyComponent", "npm:react@0.13.3/lib/ReactBrowserEventEmitter", "npm:react@0.13.3/lib/ReactNativeComponent", "npm:react@0.13.3/lib/ReactDOMComponent", "npm:react@0.13.3/lib/ReactPerf", "npm:react@0.13.3/lib/ReactRootIndex", "npm:react@0.13.3/lib/ReactUpdates"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var DOMProperty = require("npm:react@0.13.3/lib/DOMProperty");
  var EventPluginHub = require("npm:react@0.13.3/lib/EventPluginHub");
  var ReactComponentEnvironment = require("npm:react@0.13.3/lib/ReactComponentEnvironment");
  var ReactClass = require("npm:react@0.13.3/lib/ReactClass");
  var ReactEmptyComponent = require("npm:react@0.13.3/lib/ReactEmptyComponent");
  var ReactBrowserEventEmitter = require("npm:react@0.13.3/lib/ReactBrowserEventEmitter");
  var ReactNativeComponent = require("npm:react@0.13.3/lib/ReactNativeComponent");
  var ReactDOMComponent = require("npm:react@0.13.3/lib/ReactDOMComponent");
  var ReactPerf = require("npm:react@0.13.3/lib/ReactPerf");
  var ReactRootIndex = require("npm:react@0.13.3/lib/ReactRootIndex");
  var ReactUpdates = require("npm:react@0.13.3/lib/ReactUpdates");
  var ReactInjection = {
    Component: ReactComponentEnvironment.injection,
    Class: ReactClass.injection,
    DOMComponent: ReactDOMComponent.injection,
    DOMProperty: DOMProperty.injection,
    EmptyComponent: ReactEmptyComponent.injection,
    EventPluginHub: EventPluginHub.injection,
    EventEmitter: ReactBrowserEventEmitter.injection,
    NativeComponent: ReactNativeComponent.injection,
    Perf: ReactPerf.injection,
    RootIndex: ReactRootIndex.injection,
    Updates: ReactUpdates.injection
  };
  module.exports = ReactInjection;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/getNodeForCharacterOffset", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  function getLeafNode(node) {
    while (node && node.firstChild) {
      node = node.firstChild;
    }
    return node;
  }
  function getSiblingNode(node) {
    while (node) {
      if (node.nextSibling) {
        return node.nextSibling;
      }
      node = node.parentNode;
    }
  }
  function getNodeForCharacterOffset(root, offset) {
    var node = getLeafNode(root);
    var nodeStart = 0;
    var nodeEnd = 0;
    while (node) {
      if (node.nodeType === 3) {
        nodeEnd = nodeStart + node.textContent.length;
        if (nodeStart <= offset && nodeEnd >= offset) {
          return {
            node: node,
            offset: offset - nodeStart
          };
        }
        nodeStart = nodeEnd;
      }
      node = getLeafNode(getSiblingNode(node));
    }
  }
  module.exports = getNodeForCharacterOffset;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/getActiveElement", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function getActiveElement() {
    try {
      return document.activeElement || document.body;
    } catch (e) {
      return document.body;
    }
  }
  module.exports = getActiveElement;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactPutListenerQueue", ["npm:react@0.13.3/lib/PooledClass", "npm:react@0.13.3/lib/ReactBrowserEventEmitter", "npm:react@0.13.3/lib/Object.assign"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var PooledClass = require("npm:react@0.13.3/lib/PooledClass");
  var ReactBrowserEventEmitter = require("npm:react@0.13.3/lib/ReactBrowserEventEmitter");
  var assign = require("npm:react@0.13.3/lib/Object.assign");
  function ReactPutListenerQueue() {
    this.listenersToPut = [];
  }
  assign(ReactPutListenerQueue.prototype, {
    enqueuePutListener: function(rootNodeID, propKey, propValue) {
      this.listenersToPut.push({
        rootNodeID: rootNodeID,
        propKey: propKey,
        propValue: propValue
      });
    },
    putListeners: function() {
      for (var i = 0; i < this.listenersToPut.length; i++) {
        var listenerToPut = this.listenersToPut[i];
        ReactBrowserEventEmitter.putListener(listenerToPut.rootNodeID, listenerToPut.propKey, listenerToPut.propValue);
      }
    },
    reset: function() {
      this.listenersToPut.length = 0;
    },
    destructor: function() {
      this.reset();
    }
  });
  PooledClass.addPoolingTo(ReactPutListenerQueue);
  module.exports = ReactPutListenerQueue;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/shallowEqual", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  function shallowEqual(objA, objB) {
    if (objA === objB) {
      return true;
    }
    var key;
    for (key in objA) {
      if (objA.hasOwnProperty(key) && (!objB.hasOwnProperty(key) || objA[key] !== objB[key])) {
        return false;
      }
    }
    for (key in objB) {
      if (objB.hasOwnProperty(key) && !objA.hasOwnProperty(key)) {
        return false;
      }
    }
    return true;
  }
  module.exports = shallowEqual;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ServerReactRootIndex", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var GLOBAL_MOUNT_POINT_MAX = Math.pow(2, 53);
  var ServerReactRootIndex = {createReactRootIndex: function() {
      return Math.ceil(Math.random() * GLOBAL_MOUNT_POINT_MAX);
    }};
  module.exports = ServerReactRootIndex;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SyntheticClipboardEvent", ["npm:react@0.13.3/lib/SyntheticEvent"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var SyntheticEvent = require("npm:react@0.13.3/lib/SyntheticEvent");
  var ClipboardEventInterface = {clipboardData: function(event) {
      return ('clipboardData' in event ? event.clipboardData : window.clipboardData);
    }};
  function SyntheticClipboardEvent(dispatchConfig, dispatchMarker, nativeEvent) {
    SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
  }
  SyntheticEvent.augmentClass(SyntheticClipboardEvent, ClipboardEventInterface);
  module.exports = SyntheticClipboardEvent;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SyntheticFocusEvent", ["npm:react@0.13.3/lib/SyntheticUIEvent"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var SyntheticUIEvent = require("npm:react@0.13.3/lib/SyntheticUIEvent");
  var FocusEventInterface = {relatedTarget: null};
  function SyntheticFocusEvent(dispatchConfig, dispatchMarker, nativeEvent) {
    SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
  }
  SyntheticUIEvent.augmentClass(SyntheticFocusEvent, FocusEventInterface);
  module.exports = SyntheticFocusEvent;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/getEventCharCode", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  function getEventCharCode(nativeEvent) {
    var charCode;
    var keyCode = nativeEvent.keyCode;
    if ('charCode' in nativeEvent) {
      charCode = nativeEvent.charCode;
      if (charCode === 0 && keyCode === 13) {
        charCode = 13;
      }
    } else {
      charCode = keyCode;
    }
    if (charCode >= 32 || charCode === 13) {
      return charCode;
    }
    return 0;
  }
  module.exports = getEventCharCode;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/getEventKey", ["npm:react@0.13.3/lib/getEventCharCode"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var getEventCharCode = require("npm:react@0.13.3/lib/getEventCharCode");
  var normalizeKey = {
    'Esc': 'Escape',
    'Spacebar': ' ',
    'Left': 'ArrowLeft',
    'Up': 'ArrowUp',
    'Right': 'ArrowRight',
    'Down': 'ArrowDown',
    'Del': 'Delete',
    'Win': 'OS',
    'Menu': 'ContextMenu',
    'Apps': 'ContextMenu',
    'Scroll': 'ScrollLock',
    'MozPrintableKey': 'Unidentified'
  };
  var translateToKey = {
    8: 'Backspace',
    9: 'Tab',
    12: 'Clear',
    13: 'Enter',
    16: 'Shift',
    17: 'Control',
    18: 'Alt',
    19: 'Pause',
    20: 'CapsLock',
    27: 'Escape',
    32: ' ',
    33: 'PageUp',
    34: 'PageDown',
    35: 'End',
    36: 'Home',
    37: 'ArrowLeft',
    38: 'ArrowUp',
    39: 'ArrowRight',
    40: 'ArrowDown',
    45: 'Insert',
    46: 'Delete',
    112: 'F1',
    113: 'F2',
    114: 'F3',
    115: 'F4',
    116: 'F5',
    117: 'F6',
    118: 'F7',
    119: 'F8',
    120: 'F9',
    121: 'F10',
    122: 'F11',
    123: 'F12',
    144: 'NumLock',
    145: 'ScrollLock',
    224: 'Meta'
  };
  function getEventKey(nativeEvent) {
    if (nativeEvent.key) {
      var key = normalizeKey[nativeEvent.key] || nativeEvent.key;
      if (key !== 'Unidentified') {
        return key;
      }
    }
    if (nativeEvent.type === 'keypress') {
      var charCode = getEventCharCode(nativeEvent);
      return charCode === 13 ? 'Enter' : String.fromCharCode(charCode);
    }
    if (nativeEvent.type === 'keydown' || nativeEvent.type === 'keyup') {
      return translateToKey[nativeEvent.keyCode] || 'Unidentified';
    }
    return '';
  }
  module.exports = getEventKey;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SyntheticDragEvent", ["npm:react@0.13.3/lib/SyntheticMouseEvent"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var SyntheticMouseEvent = require("npm:react@0.13.3/lib/SyntheticMouseEvent");
  var DragEventInterface = {dataTransfer: null};
  function SyntheticDragEvent(dispatchConfig, dispatchMarker, nativeEvent) {
    SyntheticMouseEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
  }
  SyntheticMouseEvent.augmentClass(SyntheticDragEvent, DragEventInterface);
  module.exports = SyntheticDragEvent;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SyntheticTouchEvent", ["npm:react@0.13.3/lib/SyntheticUIEvent", "npm:react@0.13.3/lib/getEventModifierState"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var SyntheticUIEvent = require("npm:react@0.13.3/lib/SyntheticUIEvent");
  var getEventModifierState = require("npm:react@0.13.3/lib/getEventModifierState");
  var TouchEventInterface = {
    touches: null,
    targetTouches: null,
    changedTouches: null,
    altKey: null,
    metaKey: null,
    ctrlKey: null,
    shiftKey: null,
    getModifierState: getEventModifierState
  };
  function SyntheticTouchEvent(dispatchConfig, dispatchMarker, nativeEvent) {
    SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
  }
  SyntheticUIEvent.augmentClass(SyntheticTouchEvent, TouchEventInterface);
  module.exports = SyntheticTouchEvent;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SyntheticWheelEvent", ["npm:react@0.13.3/lib/SyntheticMouseEvent"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var SyntheticMouseEvent = require("npm:react@0.13.3/lib/SyntheticMouseEvent");
  var WheelEventInterface = {
    deltaX: function(event) {
      return ('deltaX' in event ? event.deltaX : 'wheelDeltaX' in event ? -event.wheelDeltaX : 0);
    },
    deltaY: function(event) {
      return ('deltaY' in event ? event.deltaY : 'wheelDeltaY' in event ? -event.wheelDeltaY : 'wheelDelta' in event ? -event.wheelDelta : 0);
    },
    deltaZ: null,
    deltaMode: null
  };
  function SyntheticWheelEvent(dispatchConfig, dispatchMarker, nativeEvent) {
    SyntheticMouseEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
  }
  SyntheticMouseEvent.augmentClass(SyntheticWheelEvent, WheelEventInterface);
  module.exports = SyntheticWheelEvent;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SVGDOMPropertyConfig", ["npm:react@0.13.3/lib/DOMProperty"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var DOMProperty = require("npm:react@0.13.3/lib/DOMProperty");
  var MUST_USE_ATTRIBUTE = DOMProperty.injection.MUST_USE_ATTRIBUTE;
  var SVGDOMPropertyConfig = {
    Properties: {
      clipPath: MUST_USE_ATTRIBUTE,
      cx: MUST_USE_ATTRIBUTE,
      cy: MUST_USE_ATTRIBUTE,
      d: MUST_USE_ATTRIBUTE,
      dx: MUST_USE_ATTRIBUTE,
      dy: MUST_USE_ATTRIBUTE,
      fill: MUST_USE_ATTRIBUTE,
      fillOpacity: MUST_USE_ATTRIBUTE,
      fontFamily: MUST_USE_ATTRIBUTE,
      fontSize: MUST_USE_ATTRIBUTE,
      fx: MUST_USE_ATTRIBUTE,
      fy: MUST_USE_ATTRIBUTE,
      gradientTransform: MUST_USE_ATTRIBUTE,
      gradientUnits: MUST_USE_ATTRIBUTE,
      markerEnd: MUST_USE_ATTRIBUTE,
      markerMid: MUST_USE_ATTRIBUTE,
      markerStart: MUST_USE_ATTRIBUTE,
      offset: MUST_USE_ATTRIBUTE,
      opacity: MUST_USE_ATTRIBUTE,
      patternContentUnits: MUST_USE_ATTRIBUTE,
      patternUnits: MUST_USE_ATTRIBUTE,
      points: MUST_USE_ATTRIBUTE,
      preserveAspectRatio: MUST_USE_ATTRIBUTE,
      r: MUST_USE_ATTRIBUTE,
      rx: MUST_USE_ATTRIBUTE,
      ry: MUST_USE_ATTRIBUTE,
      spreadMethod: MUST_USE_ATTRIBUTE,
      stopColor: MUST_USE_ATTRIBUTE,
      stopOpacity: MUST_USE_ATTRIBUTE,
      stroke: MUST_USE_ATTRIBUTE,
      strokeDasharray: MUST_USE_ATTRIBUTE,
      strokeLinecap: MUST_USE_ATTRIBUTE,
      strokeOpacity: MUST_USE_ATTRIBUTE,
      strokeWidth: MUST_USE_ATTRIBUTE,
      textAnchor: MUST_USE_ATTRIBUTE,
      transform: MUST_USE_ATTRIBUTE,
      version: MUST_USE_ATTRIBUTE,
      viewBox: MUST_USE_ATTRIBUTE,
      x1: MUST_USE_ATTRIBUTE,
      x2: MUST_USE_ATTRIBUTE,
      x: MUST_USE_ATTRIBUTE,
      y1: MUST_USE_ATTRIBUTE,
      y2: MUST_USE_ATTRIBUTE,
      y: MUST_USE_ATTRIBUTE
    },
    DOMAttributeNames: {
      clipPath: 'clip-path',
      fillOpacity: 'fill-opacity',
      fontFamily: 'font-family',
      fontSize: 'font-size',
      gradientTransform: 'gradientTransform',
      gradientUnits: 'gradientUnits',
      markerEnd: 'marker-end',
      markerMid: 'marker-mid',
      markerStart: 'marker-start',
      patternContentUnits: 'patternContentUnits',
      patternUnits: 'patternUnits',
      preserveAspectRatio: 'preserveAspectRatio',
      spreadMethod: 'spreadMethod',
      stopColor: 'stop-color',
      stopOpacity: 'stop-opacity',
      strokeDasharray: 'stroke-dasharray',
      strokeLinecap: 'stroke-linecap',
      strokeOpacity: 'stroke-opacity',
      strokeWidth: 'stroke-width',
      textAnchor: 'text-anchor',
      viewBox: 'viewBox'
    }
  };
  module.exports = SVGDOMPropertyConfig;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/createFullPageComponent", ["npm:react@0.13.3/lib/ReactClass", "npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactClass = require("npm:react@0.13.3/lib/ReactClass");
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    function createFullPageComponent(tag) {
      var elementFactory = ReactElement.createFactory(tag);
      var FullPageComponent = ReactClass.createClass({
        tagName: tag.toUpperCase(),
        displayName: 'ReactFullPageComponent' + tag,
        componentWillUnmount: function() {
          ("production" !== process.env.NODE_ENV ? invariant(false, '%s tried to unmount. Because of cross-browser quirks it is ' + 'impossible to unmount some top-level components (eg <html>, <head>, ' + 'and <body>) reliably and efficiently. To fix this, have a single ' + 'top-level component that never unmounts render these elements.', this.constructor.displayName) : invariant(false));
        },
        render: function() {
          return elementFactory(this.props);
        }
      });
      return FullPageComponent;
    }
    module.exports = createFullPageComponent;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDefaultPerfAnalysis", ["npm:react@0.13.3/lib/Object.assign"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var assign = require("npm:react@0.13.3/lib/Object.assign");
  var DONT_CARE_THRESHOLD = 1.2;
  var DOM_OPERATION_TYPES = {
    '_mountImageIntoNode': 'set innerHTML',
    INSERT_MARKUP: 'set innerHTML',
    MOVE_EXISTING: 'move',
    REMOVE_NODE: 'remove',
    TEXT_CONTENT: 'set textContent',
    'updatePropertyByID': 'update attribute',
    'deletePropertyByID': 'delete attribute',
    'updateStylesByID': 'update styles',
    'updateInnerHTMLByID': 'set innerHTML',
    'dangerouslyReplaceNodeWithMarkupByID': 'replace'
  };
  function getTotalTime(measurements) {
    var totalTime = 0;
    for (var i = 0; i < measurements.length; i++) {
      var measurement = measurements[i];
      totalTime += measurement.totalTime;
    }
    return totalTime;
  }
  function getDOMSummary(measurements) {
    var items = [];
    for (var i = 0; i < measurements.length; i++) {
      var measurement = measurements[i];
      var id;
      for (id in measurement.writes) {
        measurement.writes[id].forEach(function(write) {
          items.push({
            id: id,
            type: DOM_OPERATION_TYPES[write.type] || write.type,
            args: write.args
          });
        });
      }
    }
    return items;
  }
  function getExclusiveSummary(measurements) {
    var candidates = {};
    var displayName;
    for (var i = 0; i < measurements.length; i++) {
      var measurement = measurements[i];
      var allIDs = assign({}, measurement.exclusive, measurement.inclusive);
      for (var id in allIDs) {
        displayName = measurement.displayNames[id].current;
        candidates[displayName] = candidates[displayName] || {
          componentName: displayName,
          inclusive: 0,
          exclusive: 0,
          render: 0,
          count: 0
        };
        if (measurement.render[id]) {
          candidates[displayName].render += measurement.render[id];
        }
        if (measurement.exclusive[id]) {
          candidates[displayName].exclusive += measurement.exclusive[id];
        }
        if (measurement.inclusive[id]) {
          candidates[displayName].inclusive += measurement.inclusive[id];
        }
        if (measurement.counts[id]) {
          candidates[displayName].count += measurement.counts[id];
        }
      }
    }
    var arr = [];
    for (displayName in candidates) {
      if (candidates[displayName].exclusive >= DONT_CARE_THRESHOLD) {
        arr.push(candidates[displayName]);
      }
    }
    arr.sort(function(a, b) {
      return b.exclusive - a.exclusive;
    });
    return arr;
  }
  function getInclusiveSummary(measurements, onlyClean) {
    var candidates = {};
    var inclusiveKey;
    for (var i = 0; i < measurements.length; i++) {
      var measurement = measurements[i];
      var allIDs = assign({}, measurement.exclusive, measurement.inclusive);
      var cleanComponents;
      if (onlyClean) {
        cleanComponents = getUnchangedComponents(measurement);
      }
      for (var id in allIDs) {
        if (onlyClean && !cleanComponents[id]) {
          continue;
        }
        var displayName = measurement.displayNames[id];
        inclusiveKey = displayName.owner + ' > ' + displayName.current;
        candidates[inclusiveKey] = candidates[inclusiveKey] || {
          componentName: inclusiveKey,
          time: 0,
          count: 0
        };
        if (measurement.inclusive[id]) {
          candidates[inclusiveKey].time += measurement.inclusive[id];
        }
        if (measurement.counts[id]) {
          candidates[inclusiveKey].count += measurement.counts[id];
        }
      }
    }
    var arr = [];
    for (inclusiveKey in candidates) {
      if (candidates[inclusiveKey].time >= DONT_CARE_THRESHOLD) {
        arr.push(candidates[inclusiveKey]);
      }
    }
    arr.sort(function(a, b) {
      return b.time - a.time;
    });
    return arr;
  }
  function getUnchangedComponents(measurement) {
    var cleanComponents = {};
    var dirtyLeafIDs = Object.keys(measurement.writes);
    var allIDs = assign({}, measurement.exclusive, measurement.inclusive);
    for (var id in allIDs) {
      var isDirty = false;
      for (var i = 0; i < dirtyLeafIDs.length; i++) {
        if (dirtyLeafIDs[i].indexOf(id) === 0) {
          isDirty = true;
          break;
        }
      }
      if (!isDirty && measurement.counts[id] > 0) {
        cleanComponents[id] = true;
      }
    }
    return cleanComponents;
  }
  var ReactDefaultPerfAnalysis = {
    getExclusiveSummary: getExclusiveSummary,
    getInclusiveSummary: getInclusiveSummary,
    getDOMSummary: getDOMSummary,
    getTotalTime: getTotalTime
  };
  module.exports = ReactDefaultPerfAnalysis;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/performance", ["npm:react@0.13.3/lib/ExecutionEnvironment"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
  var performance;
  if (ExecutionEnvironment.canUseDOM) {
    performance = window.performance || window.msPerformance || window.webkitPerformance;
  }
  module.exports = performance || {};
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactServerRenderingTransaction", ["npm:react@0.13.3/lib/PooledClass", "npm:react@0.13.3/lib/CallbackQueue", "npm:react@0.13.3/lib/ReactPutListenerQueue", "npm:react@0.13.3/lib/Transaction", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/emptyFunction"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var PooledClass = require("npm:react@0.13.3/lib/PooledClass");
  var CallbackQueue = require("npm:react@0.13.3/lib/CallbackQueue");
  var ReactPutListenerQueue = require("npm:react@0.13.3/lib/ReactPutListenerQueue");
  var Transaction = require("npm:react@0.13.3/lib/Transaction");
  var assign = require("npm:react@0.13.3/lib/Object.assign");
  var emptyFunction = require("npm:react@0.13.3/lib/emptyFunction");
  var ON_DOM_READY_QUEUEING = {
    initialize: function() {
      this.reactMountReady.reset();
    },
    close: emptyFunction
  };
  var PUT_LISTENER_QUEUEING = {
    initialize: function() {
      this.putListenerQueue.reset();
    },
    close: emptyFunction
  };
  var TRANSACTION_WRAPPERS = [PUT_LISTENER_QUEUEING, ON_DOM_READY_QUEUEING];
  function ReactServerRenderingTransaction(renderToStaticMarkup) {
    this.reinitializeTransaction();
    this.renderToStaticMarkup = renderToStaticMarkup;
    this.reactMountReady = CallbackQueue.getPooled(null);
    this.putListenerQueue = ReactPutListenerQueue.getPooled();
  }
  var Mixin = {
    getTransactionWrappers: function() {
      return TRANSACTION_WRAPPERS;
    },
    getReactMountReady: function() {
      return this.reactMountReady;
    },
    getPutListenerQueue: function() {
      return this.putListenerQueue;
    },
    destructor: function() {
      CallbackQueue.release(this.reactMountReady);
      this.reactMountReady = null;
      ReactPutListenerQueue.release(this.putListenerQueue);
      this.putListenerQueue = null;
    }
  };
  assign(ReactServerRenderingTransaction.prototype, Transaction.Mixin, Mixin);
  PooledClass.addPoolingTo(ReactServerRenderingTransaction);
  module.exports = ReactServerRenderingTransaction;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/onlyChild", ["npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    function onlyChild(children) {
      ("production" !== process.env.NODE_ENV ? invariant(ReactElement.isValidElement(children), 'onlyChild must be passed a children with exactly one child.') : invariant(ReactElement.isValidElement(children)));
      return children;
    }
    module.exports = onlyChild;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/date/now", ["npm:lodash@3.9.1/internal/getNative"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var getNative = require("npm:lodash@3.9.1/internal/getNative");
  var nativeNow = getNative(Date, 'now');
  var now = nativeNow || function() {
    return new Date().getTime();
  };
  module.exports = now;
  global.define = __define;
  return module.exports;
});



System.register("npm:radium@0.10.3/modules/mixins/match-media-item", ["npm:react@0.13.3"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var React = require("npm:react@0.13.3");
  var MatchMediaItem = {contextTypes: {mediaQueries: React.PropTypes.object}};
  module.exports = MatchMediaItem;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/arrayReduce", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function arrayReduce(array, iteratee, accumulator, initFromArray) {
    var index = -1,
        length = array.length;
    if (initFromArray && length) {
      accumulator = array[++index];
    }
    while (++index < length) {
      accumulator = iteratee(accumulator, array[index], index, array);
    }
    return accumulator;
  }
  module.exports = arrayReduce;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseForOwn", ["npm:lodash@3.9.1/internal/baseFor", "npm:lodash@3.9.1/object/keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseFor = require("npm:lodash@3.9.1/internal/baseFor"),
      keys = require("npm:lodash@3.9.1/object/keys");
  function baseForOwn(object, iteratee) {
    return baseFor(object, iteratee, keys);
  }
  module.exports = baseForOwn;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/createBaseEach", ["npm:lodash@3.9.1/internal/getLength", "npm:lodash@3.9.1/internal/isLength", "npm:lodash@3.9.1/internal/toObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var getLength = require("npm:lodash@3.9.1/internal/getLength"),
      isLength = require("npm:lodash@3.9.1/internal/isLength"),
      toObject = require("npm:lodash@3.9.1/internal/toObject");
  function createBaseEach(eachFunc, fromRight) {
    return function(collection, iteratee) {
      var length = collection ? getLength(collection) : 0;
      if (!isLength(length)) {
        return eachFunc(collection, iteratee);
      }
      var index = fromRight ? length : -1,
          iterable = toObject(collection);
      while ((fromRight ? index-- : ++index < length)) {
        if (iteratee(iterable[index], index, iterable) === false) {
          break;
        }
      }
      return collection;
    };
  }
  module.exports = createBaseEach;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/arraySome", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function arraySome(array, predicate) {
    var index = -1,
        length = array.length;
    while (++index < length) {
      if (predicate(array[index], index, array)) {
        return true;
      }
    }
    return false;
  }
  module.exports = arraySome;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/equalByTag", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var boolTag = '[object Boolean]',
      dateTag = '[object Date]',
      errorTag = '[object Error]',
      numberTag = '[object Number]',
      regexpTag = '[object RegExp]',
      stringTag = '[object String]';
  function equalByTag(object, other, tag) {
    switch (tag) {
      case boolTag:
      case dateTag:
        return +object == +other;
      case errorTag:
        return object.name == other.name && object.message == other.message;
      case numberTag:
        return (object != +object) ? other != +other : object == +other;
      case regexpTag:
      case stringTag:
        return object == (other + '');
    }
    return false;
  }
  module.exports = equalByTag;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/equalObjects", ["npm:lodash@3.9.1/object/keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var keys = require("npm:lodash@3.9.1/object/keys");
  var objectProto = Object.prototype;
  var hasOwnProperty = objectProto.hasOwnProperty;
  function equalObjects(object, other, equalFunc, customizer, isLoose, stackA, stackB) {
    var objProps = keys(object),
        objLength = objProps.length,
        othProps = keys(other),
        othLength = othProps.length;
    if (objLength != othLength && !isLoose) {
      return false;
    }
    var index = objLength;
    while (index--) {
      var key = objProps[index];
      if (!(isLoose ? key in other : hasOwnProperty.call(other, key))) {
        return false;
      }
    }
    var skipCtor = isLoose;
    while (++index < objLength) {
      key = objProps[index];
      var objValue = object[key],
          othValue = other[key],
          result = customizer ? customizer(isLoose ? othValue : objValue, isLoose ? objValue : othValue, key) : undefined;
      if (!(result === undefined ? equalFunc(objValue, othValue, customizer, isLoose, stackA, stackB) : result)) {
        return false;
      }
      skipCtor || (skipCtor = key == 'constructor');
    }
    if (!skipCtor) {
      var objCtor = object.constructor,
          othCtor = other.constructor;
      if (objCtor != othCtor && ('constructor' in object && 'constructor' in other) && !(typeof objCtor == 'function' && objCtor instanceof objCtor && typeof othCtor == 'function' && othCtor instanceof othCtor)) {
        return false;
      }
    }
    return true;
  }
  module.exports = equalObjects;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/isStrictComparable", ["npm:lodash@3.9.1/lang/isObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isObject = require("npm:lodash@3.9.1/lang/isObject");
  function isStrictComparable(value) {
    return value === value && !isObject(value);
  }
  module.exports = isStrictComparable;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/object/pairs", ["npm:lodash@3.9.1/object/keys", "npm:lodash@3.9.1/internal/toObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var keys = require("npm:lodash@3.9.1/object/keys"),
      toObject = require("npm:lodash@3.9.1/internal/toObject");
  function pairs(object) {
    object = toObject(object);
    var index = -1,
        props = keys(object),
        length = props.length,
        result = Array(length);
    while (++index < length) {
      var key = props[index];
      result[index] = [key, object[key]];
    }
    return result;
  }
  module.exports = pairs;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseGet", ["npm:lodash@3.9.1/internal/toObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var toObject = require("npm:lodash@3.9.1/internal/toObject");
  function baseGet(object, path, pathKey) {
    if (object == null) {
      return ;
    }
    if (pathKey !== undefined && pathKey in toObject(object)) {
      path = [pathKey];
    }
    var index = 0,
        length = path.length;
    while (object != null && index < length) {
      object = object[path[index++]];
    }
    return (index && index == length) ? object : undefined;
  }
  module.exports = baseGet;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseSlice", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function baseSlice(array, start, end) {
    var index = -1,
        length = array.length;
    start = start == null ? 0 : (+start || 0);
    if (start < 0) {
      start = -start > length ? 0 : (length + start);
    }
    end = (end === undefined || end > length) ? length : (+end || 0);
    if (end < 0) {
      end += length;
    }
    length = start > end ? 0 : ((end - start) >>> 0);
    start >>>= 0;
    var result = Array(length);
    while (++index < length) {
      result[index] = array[index + start];
    }
    return result;
  }
  module.exports = baseSlice;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/isKey", ["npm:lodash@3.9.1/lang/isArray", "npm:lodash@3.9.1/internal/toObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isArray = require("npm:lodash@3.9.1/lang/isArray"),
      toObject = require("npm:lodash@3.9.1/internal/toObject");
  var reIsDeepProp = /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\n\\]|\\.)*?\1)\]/,
      reIsPlainProp = /^\w*$/;
  function isKey(value, object) {
    var type = typeof value;
    if ((type == 'string' && reIsPlainProp.test(value)) || type == 'number') {
      return true;
    }
    if (isArray(value)) {
      return false;
    }
    var result = !reIsDeepProp.test(value);
    return result || (object != null && value in toObject(object));
  }
  module.exports = isKey;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/array/last", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function last(array) {
    var length = array ? array.length : 0;
    return length ? array[length - 1] : undefined;
  }
  module.exports = last;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/toPath", ["npm:lodash@3.9.1/internal/baseToString", "npm:lodash@3.9.1/lang/isArray", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var baseToString = require("npm:lodash@3.9.1/internal/baseToString"),
        isArray = require("npm:lodash@3.9.1/lang/isArray");
    var rePropName = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\n\\]|\\.)*?)\2)\]/g;
    var reEscapeChar = /\\(\\)?/g;
    function toPath(value) {
      if (isArray(value)) {
        return value;
      }
      var result = [];
      baseToString(value).replace(rePropName, function(match, number, quote, string) {
        result.push(quote ? string.replace(reEscapeChar, '$1') : (number || match));
      });
      return result;
    }
    module.exports = toPath;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/basePropertyDeep", ["npm:lodash@3.9.1/internal/baseGet", "npm:lodash@3.9.1/internal/toPath"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseGet = require("npm:lodash@3.9.1/internal/baseGet"),
      toPath = require("npm:lodash@3.9.1/internal/toPath");
  function basePropertyDeep(path) {
    var pathKey = (path + '');
    path = toPath(path);
    return function(object) {
      return baseGet(object, path, pathKey);
    };
  }
  module.exports = basePropertyDeep;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseReduce", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function baseReduce(collection, iteratee, accumulator, initFromCollection, eachFunc) {
    eachFunc(collection, function(value, index, collection) {
      accumulator = initFromCollection ? (initFromCollection = false, value) : iteratee(accumulator, value, index, collection);
    });
    return accumulator;
  }
  module.exports = baseReduce;
  global.define = __define;
  return module.exports;
});



System.register("npm:color-convert@0.5.2/conversions", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    rgb2hsl: rgb2hsl,
    rgb2hsv: rgb2hsv,
    rgb2hwb: rgb2hwb,
    rgb2cmyk: rgb2cmyk,
    rgb2keyword: rgb2keyword,
    rgb2xyz: rgb2xyz,
    rgb2lab: rgb2lab,
    rgb2lch: rgb2lch,
    hsl2rgb: hsl2rgb,
    hsl2hsv: hsl2hsv,
    hsl2hwb: hsl2hwb,
    hsl2cmyk: hsl2cmyk,
    hsl2keyword: hsl2keyword,
    hsv2rgb: hsv2rgb,
    hsv2hsl: hsv2hsl,
    hsv2hwb: hsv2hwb,
    hsv2cmyk: hsv2cmyk,
    hsv2keyword: hsv2keyword,
    hwb2rgb: hwb2rgb,
    hwb2hsl: hwb2hsl,
    hwb2hsv: hwb2hsv,
    hwb2cmyk: hwb2cmyk,
    hwb2keyword: hwb2keyword,
    cmyk2rgb: cmyk2rgb,
    cmyk2hsl: cmyk2hsl,
    cmyk2hsv: cmyk2hsv,
    cmyk2hwb: cmyk2hwb,
    cmyk2keyword: cmyk2keyword,
    keyword2rgb: keyword2rgb,
    keyword2hsl: keyword2hsl,
    keyword2hsv: keyword2hsv,
    keyword2hwb: keyword2hwb,
    keyword2cmyk: keyword2cmyk,
    keyword2lab: keyword2lab,
    keyword2xyz: keyword2xyz,
    xyz2rgb: xyz2rgb,
    xyz2lab: xyz2lab,
    xyz2lch: xyz2lch,
    lab2xyz: lab2xyz,
    lab2rgb: lab2rgb,
    lab2lch: lab2lch,
    lch2lab: lch2lab,
    lch2xyz: lch2xyz,
    lch2rgb: lch2rgb
  };
  function rgb2hsl(rgb) {
    var r = rgb[0] / 255,
        g = rgb[1] / 255,
        b = rgb[2] / 255,
        min = Math.min(r, g, b),
        max = Math.max(r, g, b),
        delta = max - min,
        h,
        s,
        l;
    if (max == min)
      h = 0;
    else if (r == max)
      h = (g - b) / delta;
    else if (g == max)
      h = 2 + (b - r) / delta;
    else if (b == max)
      h = 4 + (r - g) / delta;
    h = Math.min(h * 60, 360);
    if (h < 0)
      h += 360;
    l = (min + max) / 2;
    if (max == min)
      s = 0;
    else if (l <= 0.5)
      s = delta / (max + min);
    else
      s = delta / (2 - max - min);
    return [h, s * 100, l * 100];
  }
  function rgb2hsv(rgb) {
    var r = rgb[0],
        g = rgb[1],
        b = rgb[2],
        min = Math.min(r, g, b),
        max = Math.max(r, g, b),
        delta = max - min,
        h,
        s,
        v;
    if (max == 0)
      s = 0;
    else
      s = (delta / max * 1000) / 10;
    if (max == min)
      h = 0;
    else if (r == max)
      h = (g - b) / delta;
    else if (g == max)
      h = 2 + (b - r) / delta;
    else if (b == max)
      h = 4 + (r - g) / delta;
    h = Math.min(h * 60, 360);
    if (h < 0)
      h += 360;
    v = ((max / 255) * 1000) / 10;
    return [h, s, v];
  }
  function rgb2hwb(rgb) {
    var r = rgb[0],
        g = rgb[1],
        b = rgb[2],
        h = rgb2hsl(rgb)[0],
        w = 1 / 255 * Math.min(r, Math.min(g, b)),
        b = 1 - 1 / 255 * Math.max(r, Math.max(g, b));
    return [h, w * 100, b * 100];
  }
  function rgb2cmyk(rgb) {
    var r = rgb[0] / 255,
        g = rgb[1] / 255,
        b = rgb[2] / 255,
        c,
        m,
        y,
        k;
    k = Math.min(1 - r, 1 - g, 1 - b);
    c = (1 - r - k) / (1 - k) || 0;
    m = (1 - g - k) / (1 - k) || 0;
    y = (1 - b - k) / (1 - k) || 0;
    return [c * 100, m * 100, y * 100, k * 100];
  }
  function rgb2keyword(rgb) {
    return reverseKeywords[JSON.stringify(rgb)];
  }
  function rgb2xyz(rgb) {
    var r = rgb[0] / 255,
        g = rgb[1] / 255,
        b = rgb[2] / 255;
    r = r > 0.04045 ? Math.pow(((r + 0.055) / 1.055), 2.4) : (r / 12.92);
    g = g > 0.04045 ? Math.pow(((g + 0.055) / 1.055), 2.4) : (g / 12.92);
    b = b > 0.04045 ? Math.pow(((b + 0.055) / 1.055), 2.4) : (b / 12.92);
    var x = (r * 0.4124) + (g * 0.3576) + (b * 0.1805);
    var y = (r * 0.2126) + (g * 0.7152) + (b * 0.0722);
    var z = (r * 0.0193) + (g * 0.1192) + (b * 0.9505);
    return [x * 100, y * 100, z * 100];
  }
  function rgb2lab(rgb) {
    var xyz = rgb2xyz(rgb),
        x = xyz[0],
        y = xyz[1],
        z = xyz[2],
        l,
        a,
        b;
    x /= 95.047;
    y /= 100;
    z /= 108.883;
    x = x > 0.008856 ? Math.pow(x, 1 / 3) : (7.787 * x) + (16 / 116);
    y = y > 0.008856 ? Math.pow(y, 1 / 3) : (7.787 * y) + (16 / 116);
    z = z > 0.008856 ? Math.pow(z, 1 / 3) : (7.787 * z) + (16 / 116);
    l = (116 * y) - 16;
    a = 500 * (x - y);
    b = 200 * (y - z);
    return [l, a, b];
  }
  function rgb2lch(args) {
    return lab2lch(rgb2lab(args));
  }
  function hsl2rgb(hsl) {
    var h = hsl[0] / 360,
        s = hsl[1] / 100,
        l = hsl[2] / 100,
        t1,
        t2,
        t3,
        rgb,
        val;
    if (s == 0) {
      val = l * 255;
      return [val, val, val];
    }
    if (l < 0.5)
      t2 = l * (1 + s);
    else
      t2 = l + s - l * s;
    t1 = 2 * l - t2;
    rgb = [0, 0, 0];
    for (var i = 0; i < 3; i++) {
      t3 = h + 1 / 3 * -(i - 1);
      t3 < 0 && t3++;
      t3 > 1 && t3--;
      if (6 * t3 < 1)
        val = t1 + (t2 - t1) * 6 * t3;
      else if (2 * t3 < 1)
        val = t2;
      else if (3 * t3 < 2)
        val = t1 + (t2 - t1) * (2 / 3 - t3) * 6;
      else
        val = t1;
      rgb[i] = val * 255;
    }
    return rgb;
  }
  function hsl2hsv(hsl) {
    var h = hsl[0],
        s = hsl[1] / 100,
        l = hsl[2] / 100,
        sv,
        v;
    l *= 2;
    s *= (l <= 1) ? l : 2 - l;
    v = (l + s) / 2;
    sv = (2 * s) / (l + s);
    return [h, sv * 100, v * 100];
  }
  function hsl2hwb(args) {
    return rgb2hwb(hsl2rgb(args));
  }
  function hsl2cmyk(args) {
    return rgb2cmyk(hsl2rgb(args));
  }
  function hsl2keyword(args) {
    return rgb2keyword(hsl2rgb(args));
  }
  function hsv2rgb(hsv) {
    var h = hsv[0] / 60,
        s = hsv[1] / 100,
        v = hsv[2] / 100,
        hi = Math.floor(h) % 6;
    var f = h - Math.floor(h),
        p = 255 * v * (1 - s),
        q = 255 * v * (1 - (s * f)),
        t = 255 * v * (1 - (s * (1 - f))),
        v = 255 * v;
    switch (hi) {
      case 0:
        return [v, t, p];
      case 1:
        return [q, v, p];
      case 2:
        return [p, v, t];
      case 3:
        return [p, q, v];
      case 4:
        return [t, p, v];
      case 5:
        return [v, p, q];
    }
  }
  function hsv2hsl(hsv) {
    var h = hsv[0],
        s = hsv[1] / 100,
        v = hsv[2] / 100,
        sl,
        l;
    l = (2 - s) * v;
    sl = s * v;
    sl /= (l <= 1) ? l : 2 - l;
    sl = sl || 0;
    l /= 2;
    return [h, sl * 100, l * 100];
  }
  function hsv2hwb(args) {
    return rgb2hwb(hsv2rgb(args));
  }
  function hsv2cmyk(args) {
    return rgb2cmyk(hsv2rgb(args));
  }
  function hsv2keyword(args) {
    return rgb2keyword(hsv2rgb(args));
  }
  function hwb2rgb(hwb) {
    var h = hwb[0] / 360,
        wh = hwb[1] / 100,
        bl = hwb[2] / 100,
        ratio = wh + bl,
        i,
        v,
        f,
        n;
    if (ratio > 1) {
      wh /= ratio;
      bl /= ratio;
    }
    i = Math.floor(6 * h);
    v = 1 - bl;
    f = 6 * h - i;
    if ((i & 0x01) != 0) {
      f = 1 - f;
    }
    n = wh + f * (v - wh);
    switch (i) {
      default:
      case 6:
      case 0:
        r = v;
        g = n;
        b = wh;
        break;
      case 1:
        r = n;
        g = v;
        b = wh;
        break;
      case 2:
        r = wh;
        g = v;
        b = n;
        break;
      case 3:
        r = wh;
        g = n;
        b = v;
        break;
      case 4:
        r = n;
        g = wh;
        b = v;
        break;
      case 5:
        r = v;
        g = wh;
        b = n;
        break;
    }
    return [r * 255, g * 255, b * 255];
  }
  function hwb2hsl(args) {
    return rgb2hsl(hwb2rgb(args));
  }
  function hwb2hsv(args) {
    return rgb2hsv(hwb2rgb(args));
  }
  function hwb2cmyk(args) {
    return rgb2cmyk(hwb2rgb(args));
  }
  function hwb2keyword(args) {
    return rgb2keyword(hwb2rgb(args));
  }
  function cmyk2rgb(cmyk) {
    var c = cmyk[0] / 100,
        m = cmyk[1] / 100,
        y = cmyk[2] / 100,
        k = cmyk[3] / 100,
        r,
        g,
        b;
    r = 1 - Math.min(1, c * (1 - k) + k);
    g = 1 - Math.min(1, m * (1 - k) + k);
    b = 1 - Math.min(1, y * (1 - k) + k);
    return [r * 255, g * 255, b * 255];
  }
  function cmyk2hsl(args) {
    return rgb2hsl(cmyk2rgb(args));
  }
  function cmyk2hsv(args) {
    return rgb2hsv(cmyk2rgb(args));
  }
  function cmyk2hwb(args) {
    return rgb2hwb(cmyk2rgb(args));
  }
  function cmyk2keyword(args) {
    return rgb2keyword(cmyk2rgb(args));
  }
  function xyz2rgb(xyz) {
    var x = xyz[0] / 100,
        y = xyz[1] / 100,
        z = xyz[2] / 100,
        r,
        g,
        b;
    r = (x * 3.2406) + (y * -1.5372) + (z * -0.4986);
    g = (x * -0.9689) + (y * 1.8758) + (z * 0.0415);
    b = (x * 0.0557) + (y * -0.2040) + (z * 1.0570);
    r = r > 0.0031308 ? ((1.055 * Math.pow(r, 1.0 / 2.4)) - 0.055) : r = (r * 12.92);
    g = g > 0.0031308 ? ((1.055 * Math.pow(g, 1.0 / 2.4)) - 0.055) : g = (g * 12.92);
    b = b > 0.0031308 ? ((1.055 * Math.pow(b, 1.0 / 2.4)) - 0.055) : b = (b * 12.92);
    r = Math.min(Math.max(0, r), 1);
    g = Math.min(Math.max(0, g), 1);
    b = Math.min(Math.max(0, b), 1);
    return [r * 255, g * 255, b * 255];
  }
  function xyz2lab(xyz) {
    var x = xyz[0],
        y = xyz[1],
        z = xyz[2],
        l,
        a,
        b;
    x /= 95.047;
    y /= 100;
    z /= 108.883;
    x = x > 0.008856 ? Math.pow(x, 1 / 3) : (7.787 * x) + (16 / 116);
    y = y > 0.008856 ? Math.pow(y, 1 / 3) : (7.787 * y) + (16 / 116);
    z = z > 0.008856 ? Math.pow(z, 1 / 3) : (7.787 * z) + (16 / 116);
    l = (116 * y) - 16;
    a = 500 * (x - y);
    b = 200 * (y - z);
    return [l, a, b];
  }
  function xyz2lch(args) {
    return lab2lch(xyz2lab(args));
  }
  function lab2xyz(lab) {
    var l = lab[0],
        a = lab[1],
        b = lab[2],
        x,
        y,
        z,
        y2;
    if (l <= 8) {
      y = (l * 100) / 903.3;
      y2 = (7.787 * (y / 100)) + (16 / 116);
    } else {
      y = 100 * Math.pow((l + 16) / 116, 3);
      y2 = Math.pow(y / 100, 1 / 3);
    }
    x = x / 95.047 <= 0.008856 ? x = (95.047 * ((a / 500) + y2 - (16 / 116))) / 7.787 : 95.047 * Math.pow((a / 500) + y2, 3);
    z = z / 108.883 <= 0.008859 ? z = (108.883 * (y2 - (b / 200) - (16 / 116))) / 7.787 : 108.883 * Math.pow(y2 - (b / 200), 3);
    return [x, y, z];
  }
  function lab2lch(lab) {
    var l = lab[0],
        a = lab[1],
        b = lab[2],
        hr,
        h,
        c;
    hr = Math.atan2(b, a);
    h = hr * 360 / 2 / Math.PI;
    if (h < 0) {
      h += 360;
    }
    c = Math.sqrt(a * a + b * b);
    return [l, c, h];
  }
  function lab2rgb(args) {
    return xyz2rgb(lab2xyz(args));
  }
  function lch2lab(lch) {
    var l = lch[0],
        c = lch[1],
        h = lch[2],
        a,
        b,
        hr;
    hr = h / 360 * 2 * Math.PI;
    a = c * Math.cos(hr);
    b = c * Math.sin(hr);
    return [l, a, b];
  }
  function lch2xyz(args) {
    return lab2xyz(lch2lab(args));
  }
  function lch2rgb(args) {
    return lab2rgb(lch2lab(args));
  }
  function keyword2rgb(keyword) {
    return cssKeywords[keyword];
  }
  function keyword2hsl(args) {
    return rgb2hsl(keyword2rgb(args));
  }
  function keyword2hsv(args) {
    return rgb2hsv(keyword2rgb(args));
  }
  function keyword2hwb(args) {
    return rgb2hwb(keyword2rgb(args));
  }
  function keyword2cmyk(args) {
    return rgb2cmyk(keyword2rgb(args));
  }
  function keyword2lab(args) {
    return rgb2lab(keyword2rgb(args));
  }
  function keyword2xyz(args) {
    return rgb2xyz(keyword2rgb(args));
  }
  var cssKeywords = {
    aliceblue: [240, 248, 255],
    antiquewhite: [250, 235, 215],
    aqua: [0, 255, 255],
    aquamarine: [127, 255, 212],
    azure: [240, 255, 255],
    beige: [245, 245, 220],
    bisque: [255, 228, 196],
    black: [0, 0, 0],
    blanchedalmond: [255, 235, 205],
    blue: [0, 0, 255],
    blueviolet: [138, 43, 226],
    brown: [165, 42, 42],
    burlywood: [222, 184, 135],
    cadetblue: [95, 158, 160],
    chartreuse: [127, 255, 0],
    chocolate: [210, 105, 30],
    coral: [255, 127, 80],
    cornflowerblue: [100, 149, 237],
    cornsilk: [255, 248, 220],
    crimson: [220, 20, 60],
    cyan: [0, 255, 255],
    darkblue: [0, 0, 139],
    darkcyan: [0, 139, 139],
    darkgoldenrod: [184, 134, 11],
    darkgray: [169, 169, 169],
    darkgreen: [0, 100, 0],
    darkgrey: [169, 169, 169],
    darkkhaki: [189, 183, 107],
    darkmagenta: [139, 0, 139],
    darkolivegreen: [85, 107, 47],
    darkorange: [255, 140, 0],
    darkorchid: [153, 50, 204],
    darkred: [139, 0, 0],
    darksalmon: [233, 150, 122],
    darkseagreen: [143, 188, 143],
    darkslateblue: [72, 61, 139],
    darkslategray: [47, 79, 79],
    darkslategrey: [47, 79, 79],
    darkturquoise: [0, 206, 209],
    darkviolet: [148, 0, 211],
    deeppink: [255, 20, 147],
    deepskyblue: [0, 191, 255],
    dimgray: [105, 105, 105],
    dimgrey: [105, 105, 105],
    dodgerblue: [30, 144, 255],
    firebrick: [178, 34, 34],
    floralwhite: [255, 250, 240],
    forestgreen: [34, 139, 34],
    fuchsia: [255, 0, 255],
    gainsboro: [220, 220, 220],
    ghostwhite: [248, 248, 255],
    gold: [255, 215, 0],
    goldenrod: [218, 165, 32],
    gray: [128, 128, 128],
    green: [0, 128, 0],
    greenyellow: [173, 255, 47],
    grey: [128, 128, 128],
    honeydew: [240, 255, 240],
    hotpink: [255, 105, 180],
    indianred: [205, 92, 92],
    indigo: [75, 0, 130],
    ivory: [255, 255, 240],
    khaki: [240, 230, 140],
    lavender: [230, 230, 250],
    lavenderblush: [255, 240, 245],
    lawngreen: [124, 252, 0],
    lemonchiffon: [255, 250, 205],
    lightblue: [173, 216, 230],
    lightcoral: [240, 128, 128],
    lightcyan: [224, 255, 255],
    lightgoldenrodyellow: [250, 250, 210],
    lightgray: [211, 211, 211],
    lightgreen: [144, 238, 144],
    lightgrey: [211, 211, 211],
    lightpink: [255, 182, 193],
    lightsalmon: [255, 160, 122],
    lightseagreen: [32, 178, 170],
    lightskyblue: [135, 206, 250],
    lightslategray: [119, 136, 153],
    lightslategrey: [119, 136, 153],
    lightsteelblue: [176, 196, 222],
    lightyellow: [255, 255, 224],
    lime: [0, 255, 0],
    limegreen: [50, 205, 50],
    linen: [250, 240, 230],
    magenta: [255, 0, 255],
    maroon: [128, 0, 0],
    mediumaquamarine: [102, 205, 170],
    mediumblue: [0, 0, 205],
    mediumorchid: [186, 85, 211],
    mediumpurple: [147, 112, 219],
    mediumseagreen: [60, 179, 113],
    mediumslateblue: [123, 104, 238],
    mediumspringgreen: [0, 250, 154],
    mediumturquoise: [72, 209, 204],
    mediumvioletred: [199, 21, 133],
    midnightblue: [25, 25, 112],
    mintcream: [245, 255, 250],
    mistyrose: [255, 228, 225],
    moccasin: [255, 228, 181],
    navajowhite: [255, 222, 173],
    navy: [0, 0, 128],
    oldlace: [253, 245, 230],
    olive: [128, 128, 0],
    olivedrab: [107, 142, 35],
    orange: [255, 165, 0],
    orangered: [255, 69, 0],
    orchid: [218, 112, 214],
    palegoldenrod: [238, 232, 170],
    palegreen: [152, 251, 152],
    paleturquoise: [175, 238, 238],
    palevioletred: [219, 112, 147],
    papayawhip: [255, 239, 213],
    peachpuff: [255, 218, 185],
    peru: [205, 133, 63],
    pink: [255, 192, 203],
    plum: [221, 160, 221],
    powderblue: [176, 224, 230],
    purple: [128, 0, 128],
    rebeccapurple: [102, 51, 153],
    red: [255, 0, 0],
    rosybrown: [188, 143, 143],
    royalblue: [65, 105, 225],
    saddlebrown: [139, 69, 19],
    salmon: [250, 128, 114],
    sandybrown: [244, 164, 96],
    seagreen: [46, 139, 87],
    seashell: [255, 245, 238],
    sienna: [160, 82, 45],
    silver: [192, 192, 192],
    skyblue: [135, 206, 235],
    slateblue: [106, 90, 205],
    slategray: [112, 128, 144],
    slategrey: [112, 128, 144],
    snow: [255, 250, 250],
    springgreen: [0, 255, 127],
    steelblue: [70, 130, 180],
    tan: [210, 180, 140],
    teal: [0, 128, 128],
    thistle: [216, 191, 216],
    tomato: [255, 99, 71],
    turquoise: [64, 224, 208],
    violet: [238, 130, 238],
    wheat: [245, 222, 179],
    white: [255, 255, 255],
    whitesmoke: [245, 245, 245],
    yellow: [255, 255, 0],
    yellowgreen: [154, 205, 50]
  };
  var reverseKeywords = {};
  for (var key in cssKeywords) {
    reverseKeywords[JSON.stringify(cssKeywords[key])] = key;
  }
  global.define = __define;
  return module.exports;
});



System.register("npm:color-name@1.0.0/index.json!github:systemjs/plugin-json@0.1.0", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "aliceblue": [240, 248, 255],
    "antiquewhite": [250, 235, 215],
    "aqua": [0, 255, 255],
    "aquamarine": [127, 255, 212],
    "azure": [240, 255, 255],
    "beige": [245, 245, 220],
    "bisque": [255, 228, 196],
    "black": [0, 0, 0],
    "blanchedalmond": [255, 235, 205],
    "blue": [0, 0, 255],
    "blueviolet": [138, 43, 226],
    "brown": [165, 42, 42],
    "burlywood": [222, 184, 135],
    "cadetblue": [95, 158, 160],
    "chartreuse": [127, 255, 0],
    "chocolate": [210, 105, 30],
    "coral": [255, 127, 80],
    "cornflowerblue": [100, 149, 237],
    "cornsilk": [255, 248, 220],
    "crimson": [220, 20, 60],
    "cyan": [0, 255, 255],
    "darkblue": [0, 0, 139],
    "darkcyan": [0, 139, 139],
    "darkgoldenrod": [184, 134, 11],
    "darkgray": [169, 169, 169],
    "darkgreen": [0, 100, 0],
    "darkgrey": [169, 169, 169],
    "darkkhaki": [189, 183, 107],
    "darkmagenta": [139, 0, 139],
    "darkolivegreen": [85, 107, 47],
    "darkorange": [255, 140, 0],
    "darkorchid": [153, 50, 204],
    "darkred": [139, 0, 0],
    "darksalmon": [233, 150, 122],
    "darkseagreen": [143, 188, 143],
    "darkslateblue": [72, 61, 139],
    "darkslategray": [47, 79, 79],
    "darkslategrey": [47, 79, 79],
    "darkturquoise": [0, 206, 209],
    "darkviolet": [148, 0, 211],
    "deeppink": [255, 20, 147],
    "deepskyblue": [0, 191, 255],
    "dimgray": [105, 105, 105],
    "dimgrey": [105, 105, 105],
    "dodgerblue": [30, 144, 255],
    "firebrick": [178, 34, 34],
    "floralwhite": [255, 250, 240],
    "forestgreen": [34, 139, 34],
    "fuchsia": [255, 0, 255],
    "gainsboro": [220, 220, 220],
    "ghostwhite": [248, 248, 255],
    "gold": [255, 215, 0],
    "goldenrod": [218, 165, 32],
    "gray": [128, 128, 128],
    "green": [0, 128, 0],
    "greenyellow": [173, 255, 47],
    "grey": [128, 128, 128],
    "honeydew": [240, 255, 240],
    "hotpink": [255, 105, 180],
    "indianred": [205, 92, 92],
    "indigo": [75, 0, 130],
    "ivory": [255, 255, 240],
    "khaki": [240, 230, 140],
    "lavender": [230, 230, 250],
    "lavenderblush": [255, 240, 245],
    "lawngreen": [124, 252, 0],
    "lemonchiffon": [255, 250, 205],
    "lightblue": [173, 216, 230],
    "lightcoral": [240, 128, 128],
    "lightcyan": [224, 255, 255],
    "lightgoldenrodyellow": [250, 250, 210],
    "lightgray": [211, 211, 211],
    "lightgreen": [144, 238, 144],
    "lightgrey": [211, 211, 211],
    "lightpink": [255, 182, 193],
    "lightsalmon": [255, 160, 122],
    "lightseagreen": [32, 178, 170],
    "lightskyblue": [135, 206, 250],
    "lightslategray": [119, 136, 153],
    "lightslategrey": [119, 136, 153],
    "lightsteelblue": [176, 196, 222],
    "lightyellow": [255, 255, 224],
    "lime": [0, 255, 0],
    "limegreen": [50, 205, 50],
    "linen": [250, 240, 230],
    "magenta": [255, 0, 255],
    "maroon": [128, 0, 0],
    "mediumaquamarine": [102, 205, 170],
    "mediumblue": [0, 0, 205],
    "mediumorchid": [186, 85, 211],
    "mediumpurple": [147, 112, 219],
    "mediumseagreen": [60, 179, 113],
    "mediumslateblue": [123, 104, 238],
    "mediumspringgreen": [0, 250, 154],
    "mediumturquoise": [72, 209, 204],
    "mediumvioletred": [199, 21, 133],
    "midnightblue": [25, 25, 112],
    "mintcream": [245, 255, 250],
    "mistyrose": [255, 228, 225],
    "moccasin": [255, 228, 181],
    "navajowhite": [255, 222, 173],
    "navy": [0, 0, 128],
    "oldlace": [253, 245, 230],
    "olive": [128, 128, 0],
    "olivedrab": [107, 142, 35],
    "orange": [255, 165, 0],
    "orangered": [255, 69, 0],
    "orchid": [218, 112, 214],
    "palegoldenrod": [238, 232, 170],
    "palegreen": [152, 251, 152],
    "paleturquoise": [175, 238, 238],
    "palevioletred": [219, 112, 147],
    "papayawhip": [255, 239, 213],
    "peachpuff": [255, 218, 185],
    "peru": [205, 133, 63],
    "pink": [255, 192, 203],
    "plum": [221, 160, 221],
    "powderblue": [176, 224, 230],
    "purple": [128, 0, 128],
    "rebeccapurple": [102, 51, 153],
    "red": [255, 0, 0],
    "rosybrown": [188, 143, 143],
    "royalblue": [65, 105, 225],
    "saddlebrown": [139, 69, 19],
    "salmon": [250, 128, 114],
    "sandybrown": [244, 164, 96],
    "seagreen": [46, 139, 87],
    "seashell": [255, 245, 238],
    "sienna": [160, 82, 45],
    "silver": [192, 192, 192],
    "skyblue": [135, 206, 235],
    "slateblue": [106, 90, 205],
    "slategray": [112, 128, 144],
    "slategrey": [112, 128, 144],
    "snow": [255, 250, 250],
    "springgreen": [0, 255, 127],
    "steelblue": [70, 130, 180],
    "tan": [210, 180, 140],
    "teal": [0, 128, 128],
    "thistle": [216, 191, 216],
    "tomato": [255, 99, 71],
    "turquoise": [64, 224, 208],
    "violet": [238, 130, 238],
    "wheat": [245, 222, 179],
    "white": [255, 255, 255],
    "whitesmoke": [245, 245, 245],
    "yellow": [255, 255, 0],
    "yellowgreen": [154, 205, 50]
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:immutable@3.7.2/dist/immutable", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  (function(global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() : typeof define === 'function' && define.amd ? define(factory) : global.Immutable = factory();
  }(this, function() {
    'use strict';
    var SLICE$0 = Array.prototype.slice;
    function createClass(ctor, superClass) {
      if (superClass) {
        ctor.prototype = Object.create(superClass.prototype);
      }
      ctor.prototype.constructor = ctor;
    }
    var DELETE = 'delete';
    var SHIFT = 5;
    var SIZE = 1 << SHIFT;
    var MASK = SIZE - 1;
    var NOT_SET = {};
    var CHANGE_LENGTH = {value: false};
    var DID_ALTER = {value: false};
    function MakeRef(ref) {
      ref.value = false;
      return ref;
    }
    function SetRef(ref) {
      ref && (ref.value = true);
    }
    function OwnerID() {}
    function arrCopy(arr, offset) {
      offset = offset || 0;
      var len = Math.max(0, arr.length - offset);
      var newArr = new Array(len);
      for (var ii = 0; ii < len; ii++) {
        newArr[ii] = arr[ii + offset];
      }
      return newArr;
    }
    function ensureSize(iter) {
      if (iter.size === undefined) {
        iter.size = iter.__iterate(returnTrue);
      }
      return iter.size;
    }
    function wrapIndex(iter, index) {
      return index >= 0 ? (+index) : ensureSize(iter) + (+index);
    }
    function returnTrue() {
      return true;
    }
    function wholeSlice(begin, end, size) {
      return (begin === 0 || (size !== undefined && begin <= -size)) && (end === undefined || (size !== undefined && end >= size));
    }
    function resolveBegin(begin, size) {
      return resolveIndex(begin, size, 0);
    }
    function resolveEnd(end, size) {
      return resolveIndex(end, size, size);
    }
    function resolveIndex(index, size, defaultIndex) {
      return index === undefined ? defaultIndex : index < 0 ? Math.max(0, size + index) : size === undefined ? index : Math.min(size, index);
    }
    function Iterable(value) {
      return isIterable(value) ? value : Seq(value);
    }
    createClass(KeyedIterable, Iterable);
    function KeyedIterable(value) {
      return isKeyed(value) ? value : KeyedSeq(value);
    }
    createClass(IndexedIterable, Iterable);
    function IndexedIterable(value) {
      return isIndexed(value) ? value : IndexedSeq(value);
    }
    createClass(SetIterable, Iterable);
    function SetIterable(value) {
      return isIterable(value) && !isAssociative(value) ? value : SetSeq(value);
    }
    function isIterable(maybeIterable) {
      return !!(maybeIterable && maybeIterable[IS_ITERABLE_SENTINEL]);
    }
    function isKeyed(maybeKeyed) {
      return !!(maybeKeyed && maybeKeyed[IS_KEYED_SENTINEL]);
    }
    function isIndexed(maybeIndexed) {
      return !!(maybeIndexed && maybeIndexed[IS_INDEXED_SENTINEL]);
    }
    function isAssociative(maybeAssociative) {
      return isKeyed(maybeAssociative) || isIndexed(maybeAssociative);
    }
    function isOrdered(maybeOrdered) {
      return !!(maybeOrdered && maybeOrdered[IS_ORDERED_SENTINEL]);
    }
    Iterable.isIterable = isIterable;
    Iterable.isKeyed = isKeyed;
    Iterable.isIndexed = isIndexed;
    Iterable.isAssociative = isAssociative;
    Iterable.isOrdered = isOrdered;
    Iterable.Keyed = KeyedIterable;
    Iterable.Indexed = IndexedIterable;
    Iterable.Set = SetIterable;
    var IS_ITERABLE_SENTINEL = '@@__IMMUTABLE_ITERABLE__@@';
    var IS_KEYED_SENTINEL = '@@__IMMUTABLE_KEYED__@@';
    var IS_INDEXED_SENTINEL = '@@__IMMUTABLE_INDEXED__@@';
    var IS_ORDERED_SENTINEL = '@@__IMMUTABLE_ORDERED__@@';
    var ITERATE_KEYS = 0;
    var ITERATE_VALUES = 1;
    var ITERATE_ENTRIES = 2;
    var REAL_ITERATOR_SYMBOL = typeof Symbol === 'function' && Symbol.iterator;
    var FAUX_ITERATOR_SYMBOL = '@@iterator';
    var ITERATOR_SYMBOL = REAL_ITERATOR_SYMBOL || FAUX_ITERATOR_SYMBOL;
    function src_Iterator__Iterator(next) {
      this.next = next;
    }
    src_Iterator__Iterator.prototype.toString = function() {
      return '[Iterator]';
    };
    src_Iterator__Iterator.KEYS = ITERATE_KEYS;
    src_Iterator__Iterator.VALUES = ITERATE_VALUES;
    src_Iterator__Iterator.ENTRIES = ITERATE_ENTRIES;
    src_Iterator__Iterator.prototype.inspect = src_Iterator__Iterator.prototype.toSource = function() {
      return this.toString();
    };
    src_Iterator__Iterator.prototype[ITERATOR_SYMBOL] = function() {
      return this;
    };
    function iteratorValue(type, k, v, iteratorResult) {
      var value = type === 0 ? k : type === 1 ? v : [k, v];
      iteratorResult ? (iteratorResult.value = value) : (iteratorResult = {
        value: value,
        done: false
      });
      return iteratorResult;
    }
    function iteratorDone() {
      return {
        value: undefined,
        done: true
      };
    }
    function hasIterator(maybeIterable) {
      return !!getIteratorFn(maybeIterable);
    }
    function isIterator(maybeIterator) {
      return maybeIterator && typeof maybeIterator.next === 'function';
    }
    function getIterator(iterable) {
      var iteratorFn = getIteratorFn(iterable);
      return iteratorFn && iteratorFn.call(iterable);
    }
    function getIteratorFn(iterable) {
      var iteratorFn = iterable && ((REAL_ITERATOR_SYMBOL && iterable[REAL_ITERATOR_SYMBOL]) || iterable[FAUX_ITERATOR_SYMBOL]);
      if (typeof iteratorFn === 'function') {
        return iteratorFn;
      }
    }
    function isArrayLike(value) {
      return value && typeof value.length === 'number';
    }
    createClass(Seq, Iterable);
    function Seq(value) {
      return value === null || value === undefined ? emptySequence() : isIterable(value) ? value.toSeq() : seqFromValue(value);
    }
    Seq.of = function() {
      return Seq(arguments);
    };
    Seq.prototype.toSeq = function() {
      return this;
    };
    Seq.prototype.toString = function() {
      return this.__toString('Seq {', '}');
    };
    Seq.prototype.cacheResult = function() {
      if (!this._cache && this.__iterateUncached) {
        this._cache = this.entrySeq().toArray();
        this.size = this._cache.length;
      }
      return this;
    };
    Seq.prototype.__iterate = function(fn, reverse) {
      return seqIterate(this, fn, reverse, true);
    };
    Seq.prototype.__iterator = function(type, reverse) {
      return seqIterator(this, type, reverse, true);
    };
    createClass(KeyedSeq, Seq);
    function KeyedSeq(value) {
      return value === null || value === undefined ? emptySequence().toKeyedSeq() : isIterable(value) ? (isKeyed(value) ? value.toSeq() : value.fromEntrySeq()) : keyedSeqFromValue(value);
    }
    KeyedSeq.prototype.toKeyedSeq = function() {
      return this;
    };
    createClass(IndexedSeq, Seq);
    function IndexedSeq(value) {
      return value === null || value === undefined ? emptySequence() : !isIterable(value) ? indexedSeqFromValue(value) : isKeyed(value) ? value.entrySeq() : value.toIndexedSeq();
    }
    IndexedSeq.of = function() {
      return IndexedSeq(arguments);
    };
    IndexedSeq.prototype.toIndexedSeq = function() {
      return this;
    };
    IndexedSeq.prototype.toString = function() {
      return this.__toString('Seq [', ']');
    };
    IndexedSeq.prototype.__iterate = function(fn, reverse) {
      return seqIterate(this, fn, reverse, false);
    };
    IndexedSeq.prototype.__iterator = function(type, reverse) {
      return seqIterator(this, type, reverse, false);
    };
    createClass(SetSeq, Seq);
    function SetSeq(value) {
      return (value === null || value === undefined ? emptySequence() : !isIterable(value) ? indexedSeqFromValue(value) : isKeyed(value) ? value.entrySeq() : value).toSetSeq();
    }
    SetSeq.of = function() {
      return SetSeq(arguments);
    };
    SetSeq.prototype.toSetSeq = function() {
      return this;
    };
    Seq.isSeq = isSeq;
    Seq.Keyed = KeyedSeq;
    Seq.Set = SetSeq;
    Seq.Indexed = IndexedSeq;
    var IS_SEQ_SENTINEL = '@@__IMMUTABLE_SEQ__@@';
    Seq.prototype[IS_SEQ_SENTINEL] = true;
    createClass(ArraySeq, IndexedSeq);
    function ArraySeq(array) {
      this._array = array;
      this.size = array.length;
    }
    ArraySeq.prototype.get = function(index, notSetValue) {
      return this.has(index) ? this._array[wrapIndex(this, index)] : notSetValue;
    };
    ArraySeq.prototype.__iterate = function(fn, reverse) {
      var array = this._array;
      var maxIndex = array.length - 1;
      for (var ii = 0; ii <= maxIndex; ii++) {
        if (fn(array[reverse ? maxIndex - ii : ii], ii, this) === false) {
          return ii + 1;
        }
      }
      return ii;
    };
    ArraySeq.prototype.__iterator = function(type, reverse) {
      var array = this._array;
      var maxIndex = array.length - 1;
      var ii = 0;
      return new src_Iterator__Iterator(function() {
        return ii > maxIndex ? iteratorDone() : iteratorValue(type, ii, array[reverse ? maxIndex - ii++ : ii++]);
      });
    };
    createClass(ObjectSeq, KeyedSeq);
    function ObjectSeq(object) {
      var keys = Object.keys(object);
      this._object = object;
      this._keys = keys;
      this.size = keys.length;
    }
    ObjectSeq.prototype.get = function(key, notSetValue) {
      if (notSetValue !== undefined && !this.has(key)) {
        return notSetValue;
      }
      return this._object[key];
    };
    ObjectSeq.prototype.has = function(key) {
      return this._object.hasOwnProperty(key);
    };
    ObjectSeq.prototype.__iterate = function(fn, reverse) {
      var object = this._object;
      var keys = this._keys;
      var maxIndex = keys.length - 1;
      for (var ii = 0; ii <= maxIndex; ii++) {
        var key = keys[reverse ? maxIndex - ii : ii];
        if (fn(object[key], key, this) === false) {
          return ii + 1;
        }
      }
      return ii;
    };
    ObjectSeq.prototype.__iterator = function(type, reverse) {
      var object = this._object;
      var keys = this._keys;
      var maxIndex = keys.length - 1;
      var ii = 0;
      return new src_Iterator__Iterator(function() {
        var key = keys[reverse ? maxIndex - ii : ii];
        return ii++ > maxIndex ? iteratorDone() : iteratorValue(type, key, object[key]);
      });
    };
    ObjectSeq.prototype[IS_ORDERED_SENTINEL] = true;
    createClass(IterableSeq, IndexedSeq);
    function IterableSeq(iterable) {
      this._iterable = iterable;
      this.size = iterable.length || iterable.size;
    }
    IterableSeq.prototype.__iterateUncached = function(fn, reverse) {
      if (reverse) {
        return this.cacheResult().__iterate(fn, reverse);
      }
      var iterable = this._iterable;
      var iterator = getIterator(iterable);
      var iterations = 0;
      if (isIterator(iterator)) {
        var step;
        while (!(step = iterator.next()).done) {
          if (fn(step.value, iterations++, this) === false) {
            break;
          }
        }
      }
      return iterations;
    };
    IterableSeq.prototype.__iteratorUncached = function(type, reverse) {
      if (reverse) {
        return this.cacheResult().__iterator(type, reverse);
      }
      var iterable = this._iterable;
      var iterator = getIterator(iterable);
      if (!isIterator(iterator)) {
        return new src_Iterator__Iterator(iteratorDone);
      }
      var iterations = 0;
      return new src_Iterator__Iterator(function() {
        var step = iterator.next();
        return step.done ? step : iteratorValue(type, iterations++, step.value);
      });
    };
    createClass(IteratorSeq, IndexedSeq);
    function IteratorSeq(iterator) {
      this._iterator = iterator;
      this._iteratorCache = [];
    }
    IteratorSeq.prototype.__iterateUncached = function(fn, reverse) {
      if (reverse) {
        return this.cacheResult().__iterate(fn, reverse);
      }
      var iterator = this._iterator;
      var cache = this._iteratorCache;
      var iterations = 0;
      while (iterations < cache.length) {
        if (fn(cache[iterations], iterations++, this) === false) {
          return iterations;
        }
      }
      var step;
      while (!(step = iterator.next()).done) {
        var val = step.value;
        cache[iterations] = val;
        if (fn(val, iterations++, this) === false) {
          break;
        }
      }
      return iterations;
    };
    IteratorSeq.prototype.__iteratorUncached = function(type, reverse) {
      if (reverse) {
        return this.cacheResult().__iterator(type, reverse);
      }
      var iterator = this._iterator;
      var cache = this._iteratorCache;
      var iterations = 0;
      return new src_Iterator__Iterator(function() {
        if (iterations >= cache.length) {
          var step = iterator.next();
          if (step.done) {
            return step;
          }
          cache[iterations] = step.value;
        }
        return iteratorValue(type, iterations, cache[iterations++]);
      });
    };
    function isSeq(maybeSeq) {
      return !!(maybeSeq && maybeSeq[IS_SEQ_SENTINEL]);
    }
    var EMPTY_SEQ;
    function emptySequence() {
      return EMPTY_SEQ || (EMPTY_SEQ = new ArraySeq([]));
    }
    function keyedSeqFromValue(value) {
      var seq = Array.isArray(value) ? new ArraySeq(value).fromEntrySeq() : isIterator(value) ? new IteratorSeq(value).fromEntrySeq() : hasIterator(value) ? new IterableSeq(value).fromEntrySeq() : typeof value === 'object' ? new ObjectSeq(value) : undefined;
      if (!seq) {
        throw new TypeError('Expected Array or iterable object of [k, v] entries, ' + 'or keyed object: ' + value);
      }
      return seq;
    }
    function indexedSeqFromValue(value) {
      var seq = maybeIndexedSeqFromValue(value);
      if (!seq) {
        throw new TypeError('Expected Array or iterable object of values: ' + value);
      }
      return seq;
    }
    function seqFromValue(value) {
      var seq = maybeIndexedSeqFromValue(value) || (typeof value === 'object' && new ObjectSeq(value));
      if (!seq) {
        throw new TypeError('Expected Array or iterable object of values, or keyed object: ' + value);
      }
      return seq;
    }
    function maybeIndexedSeqFromValue(value) {
      return (isArrayLike(value) ? new ArraySeq(value) : isIterator(value) ? new IteratorSeq(value) : hasIterator(value) ? new IterableSeq(value) : undefined);
    }
    function seqIterate(seq, fn, reverse, useKeys) {
      var cache = seq._cache;
      if (cache) {
        var maxIndex = cache.length - 1;
        for (var ii = 0; ii <= maxIndex; ii++) {
          var entry = cache[reverse ? maxIndex - ii : ii];
          if (fn(entry[1], useKeys ? entry[0] : ii, seq) === false) {
            return ii + 1;
          }
        }
        return ii;
      }
      return seq.__iterateUncached(fn, reverse);
    }
    function seqIterator(seq, type, reverse, useKeys) {
      var cache = seq._cache;
      if (cache) {
        var maxIndex = cache.length - 1;
        var ii = 0;
        return new src_Iterator__Iterator(function() {
          var entry = cache[reverse ? maxIndex - ii : ii];
          return ii++ > maxIndex ? iteratorDone() : iteratorValue(type, useKeys ? entry[0] : ii - 1, entry[1]);
        });
      }
      return seq.__iteratorUncached(type, reverse);
    }
    createClass(Collection, Iterable);
    function Collection() {
      throw TypeError('Abstract');
    }
    createClass(KeyedCollection, Collection);
    function KeyedCollection() {}
    createClass(IndexedCollection, Collection);
    function IndexedCollection() {}
    createClass(SetCollection, Collection);
    function SetCollection() {}
    Collection.Keyed = KeyedCollection;
    Collection.Indexed = IndexedCollection;
    Collection.Set = SetCollection;
    function is(valueA, valueB) {
      if (valueA === valueB || (valueA !== valueA && valueB !== valueB)) {
        return true;
      }
      if (!valueA || !valueB) {
        return false;
      }
      if (typeof valueA.valueOf === 'function' && typeof valueB.valueOf === 'function') {
        valueA = valueA.valueOf();
        valueB = valueB.valueOf();
        if (valueA === valueB || (valueA !== valueA && valueB !== valueB)) {
          return true;
        }
        if (!valueA || !valueB) {
          return false;
        }
      }
      if (typeof valueA.equals === 'function' && typeof valueB.equals === 'function' && valueA.equals(valueB)) {
        return true;
      }
      return false;
    }
    function fromJS(json, converter) {
      return converter ? fromJSWith(converter, json, '', {'': json}) : fromJSDefault(json);
    }
    function fromJSWith(converter, json, key, parentJSON) {
      if (Array.isArray(json)) {
        return converter.call(parentJSON, key, IndexedSeq(json).map(function(v, k) {
          return fromJSWith(converter, v, k, json);
        }));
      }
      if (isPlainObj(json)) {
        return converter.call(parentJSON, key, KeyedSeq(json).map(function(v, k) {
          return fromJSWith(converter, v, k, json);
        }));
      }
      return json;
    }
    function fromJSDefault(json) {
      if (Array.isArray(json)) {
        return IndexedSeq(json).map(fromJSDefault).toList();
      }
      if (isPlainObj(json)) {
        return KeyedSeq(json).map(fromJSDefault).toMap();
      }
      return json;
    }
    function isPlainObj(value) {
      return value && (value.constructor === Object || value.constructor === undefined);
    }
    var src_Math__imul = typeof Math.imul === 'function' && Math.imul(0xffffffff, 2) === -2 ? Math.imul : function imul(a, b) {
      a = a | 0;
      b = b | 0;
      var c = a & 0xffff;
      var d = b & 0xffff;
      return (c * d) + ((((a >>> 16) * d + c * (b >>> 16)) << 16) >>> 0) | 0;
    };
    function smi(i32) {
      return ((i32 >>> 1) & 0x40000000) | (i32 & 0xBFFFFFFF);
    }
    function hash(o) {
      if (o === false || o === null || o === undefined) {
        return 0;
      }
      if (typeof o.valueOf === 'function') {
        o = o.valueOf();
        if (o === false || o === null || o === undefined) {
          return 0;
        }
      }
      if (o === true) {
        return 1;
      }
      var type = typeof o;
      if (type === 'number') {
        var h = o | 0;
        if (h !== o) {
          h ^= o * 0xFFFFFFFF;
        }
        while (o > 0xFFFFFFFF) {
          o /= 0xFFFFFFFF;
          h ^= o;
        }
        return smi(h);
      }
      if (type === 'string') {
        return o.length > STRING_HASH_CACHE_MIN_STRLEN ? cachedHashString(o) : hashString(o);
      }
      if (typeof o.hashCode === 'function') {
        return o.hashCode();
      }
      return hashJSObj(o);
    }
    function cachedHashString(string) {
      var hash = stringHashCache[string];
      if (hash === undefined) {
        hash = hashString(string);
        if (STRING_HASH_CACHE_SIZE === STRING_HASH_CACHE_MAX_SIZE) {
          STRING_HASH_CACHE_SIZE = 0;
          stringHashCache = {};
        }
        STRING_HASH_CACHE_SIZE++;
        stringHashCache[string] = hash;
      }
      return hash;
    }
    function hashString(string) {
      var hash = 0;
      for (var ii = 0; ii < string.length; ii++) {
        hash = 31 * hash + string.charCodeAt(ii) | 0;
      }
      return smi(hash);
    }
    function hashJSObj(obj) {
      var hash;
      if (usingWeakMap) {
        hash = weakMap.get(obj);
        if (hash !== undefined) {
          return hash;
        }
      }
      hash = obj[UID_HASH_KEY];
      if (hash !== undefined) {
        return hash;
      }
      if (!canDefineProperty) {
        hash = obj.propertyIsEnumerable && obj.propertyIsEnumerable[UID_HASH_KEY];
        if (hash !== undefined) {
          return hash;
        }
        hash = getIENodeHash(obj);
        if (hash !== undefined) {
          return hash;
        }
      }
      hash = ++objHashUID;
      if (objHashUID & 0x40000000) {
        objHashUID = 0;
      }
      if (usingWeakMap) {
        weakMap.set(obj, hash);
      } else if (isExtensible !== undefined && isExtensible(obj) === false) {
        throw new Error('Non-extensible objects are not allowed as keys.');
      } else if (canDefineProperty) {
        Object.defineProperty(obj, UID_HASH_KEY, {
          'enumerable': false,
          'configurable': false,
          'writable': false,
          'value': hash
        });
      } else if (obj.propertyIsEnumerable !== undefined && obj.propertyIsEnumerable === obj.constructor.prototype.propertyIsEnumerable) {
        obj.propertyIsEnumerable = function() {
          return this.constructor.prototype.propertyIsEnumerable.apply(this, arguments);
        };
        obj.propertyIsEnumerable[UID_HASH_KEY] = hash;
      } else if (obj.nodeType !== undefined) {
        obj[UID_HASH_KEY] = hash;
      } else {
        throw new Error('Unable to set a non-enumerable property on object.');
      }
      return hash;
    }
    var isExtensible = Object.isExtensible;
    var canDefineProperty = (function() {
      try {
        Object.defineProperty({}, '@', {});
        return true;
      } catch (e) {
        return false;
      }
    }());
    function getIENodeHash(node) {
      if (node && node.nodeType > 0) {
        switch (node.nodeType) {
          case 1:
            return node.uniqueID;
          case 9:
            return node.documentElement && node.documentElement.uniqueID;
        }
      }
    }
    var usingWeakMap = typeof WeakMap === 'function';
    var weakMap;
    if (usingWeakMap) {
      weakMap = new WeakMap();
    }
    var objHashUID = 0;
    var UID_HASH_KEY = '__immutablehash__';
    if (typeof Symbol === 'function') {
      UID_HASH_KEY = Symbol(UID_HASH_KEY);
    }
    var STRING_HASH_CACHE_MIN_STRLEN = 16;
    var STRING_HASH_CACHE_MAX_SIZE = 255;
    var STRING_HASH_CACHE_SIZE = 0;
    var stringHashCache = {};
    function invariant(condition, error) {
      if (!condition)
        throw new Error(error);
    }
    function assertNotInfinite(size) {
      invariant(size !== Infinity, 'Cannot perform this action with an infinite size.');
    }
    createClass(ToKeyedSequence, KeyedSeq);
    function ToKeyedSequence(indexed, useKeys) {
      this._iter = indexed;
      this._useKeys = useKeys;
      this.size = indexed.size;
    }
    ToKeyedSequence.prototype.get = function(key, notSetValue) {
      return this._iter.get(key, notSetValue);
    };
    ToKeyedSequence.prototype.has = function(key) {
      return this._iter.has(key);
    };
    ToKeyedSequence.prototype.valueSeq = function() {
      return this._iter.valueSeq();
    };
    ToKeyedSequence.prototype.reverse = function() {
      var this$0 = this;
      var reversedSequence = reverseFactory(this, true);
      if (!this._useKeys) {
        reversedSequence.valueSeq = function() {
          return this$0._iter.toSeq().reverse();
        };
      }
      return reversedSequence;
    };
    ToKeyedSequence.prototype.map = function(mapper, context) {
      var this$0 = this;
      var mappedSequence = mapFactory(this, mapper, context);
      if (!this._useKeys) {
        mappedSequence.valueSeq = function() {
          return this$0._iter.toSeq().map(mapper, context);
        };
      }
      return mappedSequence;
    };
    ToKeyedSequence.prototype.__iterate = function(fn, reverse) {
      var this$0 = this;
      var ii;
      return this._iter.__iterate(this._useKeys ? function(v, k) {
        return fn(v, k, this$0);
      } : ((ii = reverse ? resolveSize(this) : 0), function(v) {
        return fn(v, reverse ? --ii : ii++, this$0);
      }), reverse);
    };
    ToKeyedSequence.prototype.__iterator = function(type, reverse) {
      if (this._useKeys) {
        return this._iter.__iterator(type, reverse);
      }
      var iterator = this._iter.__iterator(ITERATE_VALUES, reverse);
      var ii = reverse ? resolveSize(this) : 0;
      return new src_Iterator__Iterator(function() {
        var step = iterator.next();
        return step.done ? step : iteratorValue(type, reverse ? --ii : ii++, step.value, step);
      });
    };
    ToKeyedSequence.prototype[IS_ORDERED_SENTINEL] = true;
    createClass(ToIndexedSequence, IndexedSeq);
    function ToIndexedSequence(iter) {
      this._iter = iter;
      this.size = iter.size;
    }
    ToIndexedSequence.prototype.includes = function(value) {
      return this._iter.includes(value);
    };
    ToIndexedSequence.prototype.__iterate = function(fn, reverse) {
      var this$0 = this;
      var iterations = 0;
      return this._iter.__iterate(function(v) {
        return fn(v, iterations++, this$0);
      }, reverse);
    };
    ToIndexedSequence.prototype.__iterator = function(type, reverse) {
      var iterator = this._iter.__iterator(ITERATE_VALUES, reverse);
      var iterations = 0;
      return new src_Iterator__Iterator(function() {
        var step = iterator.next();
        return step.done ? step : iteratorValue(type, iterations++, step.value, step);
      });
    };
    createClass(ToSetSequence, SetSeq);
    function ToSetSequence(iter) {
      this._iter = iter;
      this.size = iter.size;
    }
    ToSetSequence.prototype.has = function(key) {
      return this._iter.includes(key);
    };
    ToSetSequence.prototype.__iterate = function(fn, reverse) {
      var this$0 = this;
      return this._iter.__iterate(function(v) {
        return fn(v, v, this$0);
      }, reverse);
    };
    ToSetSequence.prototype.__iterator = function(type, reverse) {
      var iterator = this._iter.__iterator(ITERATE_VALUES, reverse);
      return new src_Iterator__Iterator(function() {
        var step = iterator.next();
        return step.done ? step : iteratorValue(type, step.value, step.value, step);
      });
    };
    createClass(FromEntriesSequence, KeyedSeq);
    function FromEntriesSequence(entries) {
      this._iter = entries;
      this.size = entries.size;
    }
    FromEntriesSequence.prototype.entrySeq = function() {
      return this._iter.toSeq();
    };
    FromEntriesSequence.prototype.__iterate = function(fn, reverse) {
      var this$0 = this;
      return this._iter.__iterate(function(entry) {
        if (entry) {
          validateEntry(entry);
          var indexedIterable = isIterable(entry);
          return fn(indexedIterable ? entry.get(1) : entry[1], indexedIterable ? entry.get(0) : entry[0], this$0);
        }
      }, reverse);
    };
    FromEntriesSequence.prototype.__iterator = function(type, reverse) {
      var iterator = this._iter.__iterator(ITERATE_VALUES, reverse);
      return new src_Iterator__Iterator(function() {
        while (true) {
          var step = iterator.next();
          if (step.done) {
            return step;
          }
          var entry = step.value;
          if (entry) {
            validateEntry(entry);
            var indexedIterable = isIterable(entry);
            return iteratorValue(type, indexedIterable ? entry.get(0) : entry[0], indexedIterable ? entry.get(1) : entry[1], step);
          }
        }
      });
    };
    ToIndexedSequence.prototype.cacheResult = ToKeyedSequence.prototype.cacheResult = ToSetSequence.prototype.cacheResult = FromEntriesSequence.prototype.cacheResult = cacheResultThrough;
    function flipFactory(iterable) {
      var flipSequence = makeSequence(iterable);
      flipSequence._iter = iterable;
      flipSequence.size = iterable.size;
      flipSequence.flip = function() {
        return iterable;
      };
      flipSequence.reverse = function() {
        var reversedSequence = iterable.reverse.apply(this);
        reversedSequence.flip = function() {
          return iterable.reverse();
        };
        return reversedSequence;
      };
      flipSequence.has = function(key) {
        return iterable.includes(key);
      };
      flipSequence.includes = function(key) {
        return iterable.has(key);
      };
      flipSequence.cacheResult = cacheResultThrough;
      flipSequence.__iterateUncached = function(fn, reverse) {
        var this$0 = this;
        return iterable.__iterate(function(v, k) {
          return fn(k, v, this$0) !== false;
        }, reverse);
      };
      flipSequence.__iteratorUncached = function(type, reverse) {
        if (type === ITERATE_ENTRIES) {
          var iterator = iterable.__iterator(type, reverse);
          return new src_Iterator__Iterator(function() {
            var step = iterator.next();
            if (!step.done) {
              var k = step.value[0];
              step.value[0] = step.value[1];
              step.value[1] = k;
            }
            return step;
          });
        }
        return iterable.__iterator(type === ITERATE_VALUES ? ITERATE_KEYS : ITERATE_VALUES, reverse);
      };
      return flipSequence;
    }
    function mapFactory(iterable, mapper, context) {
      var mappedSequence = makeSequence(iterable);
      mappedSequence.size = iterable.size;
      mappedSequence.has = function(key) {
        return iterable.has(key);
      };
      mappedSequence.get = function(key, notSetValue) {
        var v = iterable.get(key, NOT_SET);
        return v === NOT_SET ? notSetValue : mapper.call(context, v, key, iterable);
      };
      mappedSequence.__iterateUncached = function(fn, reverse) {
        var this$0 = this;
        return iterable.__iterate(function(v, k, c) {
          return fn(mapper.call(context, v, k, c), k, this$0) !== false;
        }, reverse);
      };
      mappedSequence.__iteratorUncached = function(type, reverse) {
        var iterator = iterable.__iterator(ITERATE_ENTRIES, reverse);
        return new src_Iterator__Iterator(function() {
          var step = iterator.next();
          if (step.done) {
            return step;
          }
          var entry = step.value;
          var key = entry[0];
          return iteratorValue(type, key, mapper.call(context, entry[1], key, iterable), step);
        });
      };
      return mappedSequence;
    }
    function reverseFactory(iterable, useKeys) {
      var reversedSequence = makeSequence(iterable);
      reversedSequence._iter = iterable;
      reversedSequence.size = iterable.size;
      reversedSequence.reverse = function() {
        return iterable;
      };
      if (iterable.flip) {
        reversedSequence.flip = function() {
          var flipSequence = flipFactory(iterable);
          flipSequence.reverse = function() {
            return iterable.flip();
          };
          return flipSequence;
        };
      }
      reversedSequence.get = function(key, notSetValue) {
        return iterable.get(useKeys ? key : -1 - key, notSetValue);
      };
      reversedSequence.has = function(key) {
        return iterable.has(useKeys ? key : -1 - key);
      };
      reversedSequence.includes = function(value) {
        return iterable.includes(value);
      };
      reversedSequence.cacheResult = cacheResultThrough;
      reversedSequence.__iterate = function(fn, reverse) {
        var this$0 = this;
        return iterable.__iterate(function(v, k) {
          return fn(v, k, this$0);
        }, !reverse);
      };
      reversedSequence.__iterator = function(type, reverse) {
        return iterable.__iterator(type, !reverse);
      };
      return reversedSequence;
    }
    function filterFactory(iterable, predicate, context, useKeys) {
      var filterSequence = makeSequence(iterable);
      if (useKeys) {
        filterSequence.has = function(key) {
          var v = iterable.get(key, NOT_SET);
          return v !== NOT_SET && !!predicate.call(context, v, key, iterable);
        };
        filterSequence.get = function(key, notSetValue) {
          var v = iterable.get(key, NOT_SET);
          return v !== NOT_SET && predicate.call(context, v, key, iterable) ? v : notSetValue;
        };
      }
      filterSequence.__iterateUncached = function(fn, reverse) {
        var this$0 = this;
        var iterations = 0;
        iterable.__iterate(function(v, k, c) {
          if (predicate.call(context, v, k, c)) {
            iterations++;
            return fn(v, useKeys ? k : iterations - 1, this$0);
          }
        }, reverse);
        return iterations;
      };
      filterSequence.__iteratorUncached = function(type, reverse) {
        var iterator = iterable.__iterator(ITERATE_ENTRIES, reverse);
        var iterations = 0;
        return new src_Iterator__Iterator(function() {
          while (true) {
            var step = iterator.next();
            if (step.done) {
              return step;
            }
            var entry = step.value;
            var key = entry[0];
            var value = entry[1];
            if (predicate.call(context, value, key, iterable)) {
              return iteratorValue(type, useKeys ? key : iterations++, value, step);
            }
          }
        });
      };
      return filterSequence;
    }
    function countByFactory(iterable, grouper, context) {
      var groups = src_Map__Map().asMutable();
      iterable.__iterate(function(v, k) {
        groups.update(grouper.call(context, v, k, iterable), 0, function(a) {
          return a + 1;
        });
      });
      return groups.asImmutable();
    }
    function groupByFactory(iterable, grouper, context) {
      var isKeyedIter = isKeyed(iterable);
      var groups = (isOrdered(iterable) ? OrderedMap() : src_Map__Map()).asMutable();
      iterable.__iterate(function(v, k) {
        groups.update(grouper.call(context, v, k, iterable), function(a) {
          return (a = a || [], a.push(isKeyedIter ? [k, v] : v), a);
        });
      });
      var coerce = iterableClass(iterable);
      return groups.map(function(arr) {
        return reify(iterable, coerce(arr));
      });
    }
    function sliceFactory(iterable, begin, end, useKeys) {
      var originalSize = iterable.size;
      if (wholeSlice(begin, end, originalSize)) {
        return iterable;
      }
      var resolvedBegin = resolveBegin(begin, originalSize);
      var resolvedEnd = resolveEnd(end, originalSize);
      if (resolvedBegin !== resolvedBegin || resolvedEnd !== resolvedEnd) {
        return sliceFactory(iterable.toSeq().cacheResult(), begin, end, useKeys);
      }
      var sliceSize = resolvedEnd - resolvedBegin;
      if (sliceSize < 0) {
        sliceSize = 0;
      }
      var sliceSeq = makeSequence(iterable);
      sliceSeq.size = sliceSize === 0 ? sliceSize : iterable.size && sliceSize || undefined;
      if (!useKeys && isSeq(iterable) && sliceSize >= 0) {
        sliceSeq.get = function(index, notSetValue) {
          index = wrapIndex(this, index);
          return index >= 0 && index < sliceSize ? iterable.get(index + resolvedBegin, notSetValue) : notSetValue;
        };
      }
      sliceSeq.__iterateUncached = function(fn, reverse) {
        var this$0 = this;
        if (sliceSize === 0) {
          return 0;
        }
        if (reverse) {
          return this.cacheResult().__iterate(fn, reverse);
        }
        var skipped = 0;
        var isSkipping = true;
        var iterations = 0;
        iterable.__iterate(function(v, k) {
          if (!(isSkipping && (isSkipping = skipped++ < resolvedBegin))) {
            iterations++;
            return fn(v, useKeys ? k : iterations - 1, this$0) !== false && iterations !== sliceSize;
          }
        });
        return iterations;
      };
      sliceSeq.__iteratorUncached = function(type, reverse) {
        if (sliceSize && reverse) {
          return this.cacheResult().__iterator(type, reverse);
        }
        var iterator = sliceSize && iterable.__iterator(type, reverse);
        var skipped = 0;
        var iterations = 0;
        return new src_Iterator__Iterator(function() {
          while (skipped++ < resolvedBegin) {
            iterator.next();
          }
          if (++iterations > sliceSize) {
            return iteratorDone();
          }
          var step = iterator.next();
          if (useKeys || type === ITERATE_VALUES) {
            return step;
          } else if (type === ITERATE_KEYS) {
            return iteratorValue(type, iterations - 1, undefined, step);
          } else {
            return iteratorValue(type, iterations - 1, step.value[1], step);
          }
        });
      };
      return sliceSeq;
    }
    function takeWhileFactory(iterable, predicate, context) {
      var takeSequence = makeSequence(iterable);
      takeSequence.__iterateUncached = function(fn, reverse) {
        var this$0 = this;
        if (reverse) {
          return this.cacheResult().__iterate(fn, reverse);
        }
        var iterations = 0;
        iterable.__iterate(function(v, k, c) {
          return predicate.call(context, v, k, c) && ++iterations && fn(v, k, this$0);
        });
        return iterations;
      };
      takeSequence.__iteratorUncached = function(type, reverse) {
        var this$0 = this;
        if (reverse) {
          return this.cacheResult().__iterator(type, reverse);
        }
        var iterator = iterable.__iterator(ITERATE_ENTRIES, reverse);
        var iterating = true;
        return new src_Iterator__Iterator(function() {
          if (!iterating) {
            return iteratorDone();
          }
          var step = iterator.next();
          if (step.done) {
            return step;
          }
          var entry = step.value;
          var k = entry[0];
          var v = entry[1];
          if (!predicate.call(context, v, k, this$0)) {
            iterating = false;
            return iteratorDone();
          }
          return type === ITERATE_ENTRIES ? step : iteratorValue(type, k, v, step);
        });
      };
      return takeSequence;
    }
    function skipWhileFactory(iterable, predicate, context, useKeys) {
      var skipSequence = makeSequence(iterable);
      skipSequence.__iterateUncached = function(fn, reverse) {
        var this$0 = this;
        if (reverse) {
          return this.cacheResult().__iterate(fn, reverse);
        }
        var isSkipping = true;
        var iterations = 0;
        iterable.__iterate(function(v, k, c) {
          if (!(isSkipping && (isSkipping = predicate.call(context, v, k, c)))) {
            iterations++;
            return fn(v, useKeys ? k : iterations - 1, this$0);
          }
        });
        return iterations;
      };
      skipSequence.__iteratorUncached = function(type, reverse) {
        var this$0 = this;
        if (reverse) {
          return this.cacheResult().__iterator(type, reverse);
        }
        var iterator = iterable.__iterator(ITERATE_ENTRIES, reverse);
        var skipping = true;
        var iterations = 0;
        return new src_Iterator__Iterator(function() {
          var step,
              k,
              v;
          do {
            step = iterator.next();
            if (step.done) {
              if (useKeys || type === ITERATE_VALUES) {
                return step;
              } else if (type === ITERATE_KEYS) {
                return iteratorValue(type, iterations++, undefined, step);
              } else {
                return iteratorValue(type, iterations++, step.value[1], step);
              }
            }
            var entry = step.value;
            k = entry[0];
            v = entry[1];
            skipping && (skipping = predicate.call(context, v, k, this$0));
          } while (skipping);
          return type === ITERATE_ENTRIES ? step : iteratorValue(type, k, v, step);
        });
      };
      return skipSequence;
    }
    function concatFactory(iterable, values) {
      var isKeyedIterable = isKeyed(iterable);
      var iters = [iterable].concat(values).map(function(v) {
        if (!isIterable(v)) {
          v = isKeyedIterable ? keyedSeqFromValue(v) : indexedSeqFromValue(Array.isArray(v) ? v : [v]);
        } else if (isKeyedIterable) {
          v = KeyedIterable(v);
        }
        return v;
      }).filter(function(v) {
        return v.size !== 0;
      });
      if (iters.length === 0) {
        return iterable;
      }
      if (iters.length === 1) {
        var singleton = iters[0];
        if (singleton === iterable || isKeyedIterable && isKeyed(singleton) || isIndexed(iterable) && isIndexed(singleton)) {
          return singleton;
        }
      }
      var concatSeq = new ArraySeq(iters);
      if (isKeyedIterable) {
        concatSeq = concatSeq.toKeyedSeq();
      } else if (!isIndexed(iterable)) {
        concatSeq = concatSeq.toSetSeq();
      }
      concatSeq = concatSeq.flatten(true);
      concatSeq.size = iters.reduce(function(sum, seq) {
        if (sum !== undefined) {
          var size = seq.size;
          if (size !== undefined) {
            return sum + size;
          }
        }
      }, 0);
      return concatSeq;
    }
    function flattenFactory(iterable, depth, useKeys) {
      var flatSequence = makeSequence(iterable);
      flatSequence.__iterateUncached = function(fn, reverse) {
        var iterations = 0;
        var stopped = false;
        function flatDeep(iter, currentDepth) {
          var this$0 = this;
          iter.__iterate(function(v, k) {
            if ((!depth || currentDepth < depth) && isIterable(v)) {
              flatDeep(v, currentDepth + 1);
            } else if (fn(v, useKeys ? k : iterations++, this$0) === false) {
              stopped = true;
            }
            return !stopped;
          }, reverse);
        }
        flatDeep(iterable, 0);
        return iterations;
      };
      flatSequence.__iteratorUncached = function(type, reverse) {
        var iterator = iterable.__iterator(type, reverse);
        var stack = [];
        var iterations = 0;
        return new src_Iterator__Iterator(function() {
          while (iterator) {
            var step = iterator.next();
            if (step.done !== false) {
              iterator = stack.pop();
              continue;
            }
            var v = step.value;
            if (type === ITERATE_ENTRIES) {
              v = v[1];
            }
            if ((!depth || stack.length < depth) && isIterable(v)) {
              stack.push(iterator);
              iterator = v.__iterator(type, reverse);
            } else {
              return useKeys ? step : iteratorValue(type, iterations++, v, step);
            }
          }
          return iteratorDone();
        });
      };
      return flatSequence;
    }
    function flatMapFactory(iterable, mapper, context) {
      var coerce = iterableClass(iterable);
      return iterable.toSeq().map(function(v, k) {
        return coerce(mapper.call(context, v, k, iterable));
      }).flatten(true);
    }
    function interposeFactory(iterable, separator) {
      var interposedSequence = makeSequence(iterable);
      interposedSequence.size = iterable.size && iterable.size * 2 - 1;
      interposedSequence.__iterateUncached = function(fn, reverse) {
        var this$0 = this;
        var iterations = 0;
        iterable.__iterate(function(v, k) {
          return (!iterations || fn(separator, iterations++, this$0) !== false) && fn(v, iterations++, this$0) !== false;
        }, reverse);
        return iterations;
      };
      interposedSequence.__iteratorUncached = function(type, reverse) {
        var iterator = iterable.__iterator(ITERATE_VALUES, reverse);
        var iterations = 0;
        var step;
        return new src_Iterator__Iterator(function() {
          if (!step || iterations % 2) {
            step = iterator.next();
            if (step.done) {
              return step;
            }
          }
          return iterations % 2 ? iteratorValue(type, iterations++, separator) : iteratorValue(type, iterations++, step.value, step);
        });
      };
      return interposedSequence;
    }
    function sortFactory(iterable, comparator, mapper) {
      if (!comparator) {
        comparator = defaultComparator;
      }
      var isKeyedIterable = isKeyed(iterable);
      var index = 0;
      var entries = iterable.toSeq().map(function(v, k) {
        return [k, v, index++, mapper ? mapper(v, k, iterable) : v];
      }).toArray();
      entries.sort(function(a, b) {
        return comparator(a[3], b[3]) || a[2] - b[2];
      }).forEach(isKeyedIterable ? function(v, i) {
        entries[i].length = 2;
      } : function(v, i) {
        entries[i] = v[1];
      });
      return isKeyedIterable ? KeyedSeq(entries) : isIndexed(iterable) ? IndexedSeq(entries) : SetSeq(entries);
    }
    function maxFactory(iterable, comparator, mapper) {
      if (!comparator) {
        comparator = defaultComparator;
      }
      if (mapper) {
        var entry = iterable.toSeq().map(function(v, k) {
          return [v, mapper(v, k, iterable)];
        }).reduce(function(a, b) {
          return maxCompare(comparator, a[1], b[1]) ? b : a;
        });
        return entry && entry[0];
      } else {
        return iterable.reduce(function(a, b) {
          return maxCompare(comparator, a, b) ? b : a;
        });
      }
    }
    function maxCompare(comparator, a, b) {
      var comp = comparator(b, a);
      return (comp === 0 && b !== a && (b === undefined || b === null || b !== b)) || comp > 0;
    }
    function zipWithFactory(keyIter, zipper, iters) {
      var zipSequence = makeSequence(keyIter);
      zipSequence.size = new ArraySeq(iters).map(function(i) {
        return i.size;
      }).min();
      zipSequence.__iterate = function(fn, reverse) {
        var iterator = this.__iterator(ITERATE_VALUES, reverse);
        var step;
        var iterations = 0;
        while (!(step = iterator.next()).done) {
          if (fn(step.value, iterations++, this) === false) {
            break;
          }
        }
        return iterations;
      };
      zipSequence.__iteratorUncached = function(type, reverse) {
        var iterators = iters.map(function(i) {
          return (i = Iterable(i), getIterator(reverse ? i.reverse() : i));
        });
        var iterations = 0;
        var isDone = false;
        return new src_Iterator__Iterator(function() {
          var steps;
          if (!isDone) {
            steps = iterators.map(function(i) {
              return i.next();
            });
            isDone = steps.some(function(s) {
              return s.done;
            });
          }
          if (isDone) {
            return iteratorDone();
          }
          return iteratorValue(type, iterations++, zipper.apply(null, steps.map(function(s) {
            return s.value;
          })));
        });
      };
      return zipSequence;
    }
    function reify(iter, seq) {
      return isSeq(iter) ? seq : iter.constructor(seq);
    }
    function validateEntry(entry) {
      if (entry !== Object(entry)) {
        throw new TypeError('Expected [K, V] tuple: ' + entry);
      }
    }
    function resolveSize(iter) {
      assertNotInfinite(iter.size);
      return ensureSize(iter);
    }
    function iterableClass(iterable) {
      return isKeyed(iterable) ? KeyedIterable : isIndexed(iterable) ? IndexedIterable : SetIterable;
    }
    function makeSequence(iterable) {
      return Object.create((isKeyed(iterable) ? KeyedSeq : isIndexed(iterable) ? IndexedSeq : SetSeq).prototype);
    }
    function cacheResultThrough() {
      if (this._iter.cacheResult) {
        this._iter.cacheResult();
        this.size = this._iter.size;
        return this;
      } else {
        return Seq.prototype.cacheResult.call(this);
      }
    }
    function defaultComparator(a, b) {
      return a > b ? 1 : a < b ? -1 : 0;
    }
    function forceIterator(keyPath) {
      var iter = getIterator(keyPath);
      if (!iter) {
        if (!isArrayLike(keyPath)) {
          throw new TypeError('Expected iterable or array-like: ' + keyPath);
        }
        iter = getIterator(Iterable(keyPath));
      }
      return iter;
    }
    createClass(src_Map__Map, KeyedCollection);
    function src_Map__Map(value) {
      return value === null || value === undefined ? emptyMap() : isMap(value) ? value : emptyMap().withMutations(function(map) {
        var iter = KeyedIterable(value);
        assertNotInfinite(iter.size);
        iter.forEach(function(v, k) {
          return map.set(k, v);
        });
      });
    }
    src_Map__Map.prototype.toString = function() {
      return this.__toString('Map {', '}');
    };
    src_Map__Map.prototype.get = function(k, notSetValue) {
      return this._root ? this._root.get(0, undefined, k, notSetValue) : notSetValue;
    };
    src_Map__Map.prototype.set = function(k, v) {
      return updateMap(this, k, v);
    };
    src_Map__Map.prototype.setIn = function(keyPath, v) {
      return this.updateIn(keyPath, NOT_SET, function() {
        return v;
      });
    };
    src_Map__Map.prototype.remove = function(k) {
      return updateMap(this, k, NOT_SET);
    };
    src_Map__Map.prototype.deleteIn = function(keyPath) {
      return this.updateIn(keyPath, function() {
        return NOT_SET;
      });
    };
    src_Map__Map.prototype.update = function(k, notSetValue, updater) {
      return arguments.length === 1 ? k(this) : this.updateIn([k], notSetValue, updater);
    };
    src_Map__Map.prototype.updateIn = function(keyPath, notSetValue, updater) {
      if (!updater) {
        updater = notSetValue;
        notSetValue = undefined;
      }
      var updatedValue = updateInDeepMap(this, forceIterator(keyPath), notSetValue, updater);
      return updatedValue === NOT_SET ? undefined : updatedValue;
    };
    src_Map__Map.prototype.clear = function() {
      if (this.size === 0) {
        return this;
      }
      if (this.__ownerID) {
        this.size = 0;
        this._root = null;
        this.__hash = undefined;
        this.__altered = true;
        return this;
      }
      return emptyMap();
    };
    src_Map__Map.prototype.merge = function() {
      return mergeIntoMapWith(this, undefined, arguments);
    };
    src_Map__Map.prototype.mergeWith = function(merger) {
      var iters = SLICE$0.call(arguments, 1);
      return mergeIntoMapWith(this, merger, iters);
    };
    src_Map__Map.prototype.mergeIn = function(keyPath) {
      var iters = SLICE$0.call(arguments, 1);
      return this.updateIn(keyPath, emptyMap(), function(m) {
        return m.merge.apply(m, iters);
      });
    };
    src_Map__Map.prototype.mergeDeep = function() {
      return mergeIntoMapWith(this, deepMerger(undefined), arguments);
    };
    src_Map__Map.prototype.mergeDeepWith = function(merger) {
      var iters = SLICE$0.call(arguments, 1);
      return mergeIntoMapWith(this, deepMerger(merger), iters);
    };
    src_Map__Map.prototype.mergeDeepIn = function(keyPath) {
      var iters = SLICE$0.call(arguments, 1);
      return this.updateIn(keyPath, emptyMap(), function(m) {
        return m.mergeDeep.apply(m, iters);
      });
    };
    src_Map__Map.prototype.sort = function(comparator) {
      return OrderedMap(sortFactory(this, comparator));
    };
    src_Map__Map.prototype.sortBy = function(mapper, comparator) {
      return OrderedMap(sortFactory(this, comparator, mapper));
    };
    src_Map__Map.prototype.withMutations = function(fn) {
      var mutable = this.asMutable();
      fn(mutable);
      return mutable.wasAltered() ? mutable.__ensureOwner(this.__ownerID) : this;
    };
    src_Map__Map.prototype.asMutable = function() {
      return this.__ownerID ? this : this.__ensureOwner(new OwnerID());
    };
    src_Map__Map.prototype.asImmutable = function() {
      return this.__ensureOwner();
    };
    src_Map__Map.prototype.wasAltered = function() {
      return this.__altered;
    };
    src_Map__Map.prototype.__iterator = function(type, reverse) {
      return new MapIterator(this, type, reverse);
    };
    src_Map__Map.prototype.__iterate = function(fn, reverse) {
      var this$0 = this;
      var iterations = 0;
      this._root && this._root.iterate(function(entry) {
        iterations++;
        return fn(entry[1], entry[0], this$0);
      }, reverse);
      return iterations;
    };
    src_Map__Map.prototype.__ensureOwner = function(ownerID) {
      if (ownerID === this.__ownerID) {
        return this;
      }
      if (!ownerID) {
        this.__ownerID = ownerID;
        this.__altered = false;
        return this;
      }
      return makeMap(this.size, this._root, ownerID, this.__hash);
    };
    function isMap(maybeMap) {
      return !!(maybeMap && maybeMap[IS_MAP_SENTINEL]);
    }
    src_Map__Map.isMap = isMap;
    var IS_MAP_SENTINEL = '@@__IMMUTABLE_MAP__@@';
    var MapPrototype = src_Map__Map.prototype;
    MapPrototype[IS_MAP_SENTINEL] = true;
    MapPrototype[DELETE] = MapPrototype.remove;
    MapPrototype.removeIn = MapPrototype.deleteIn;
    function ArrayMapNode(ownerID, entries) {
      this.ownerID = ownerID;
      this.entries = entries;
    }
    ArrayMapNode.prototype.get = function(shift, keyHash, key, notSetValue) {
      var entries = this.entries;
      for (var ii = 0,
          len = entries.length; ii < len; ii++) {
        if (is(key, entries[ii][0])) {
          return entries[ii][1];
        }
      }
      return notSetValue;
    };
    ArrayMapNode.prototype.update = function(ownerID, shift, keyHash, key, value, didChangeSize, didAlter) {
      var removed = value === NOT_SET;
      var entries = this.entries;
      var idx = 0;
      for (var len = entries.length; idx < len; idx++) {
        if (is(key, entries[idx][0])) {
          break;
        }
      }
      var exists = idx < len;
      if (exists ? entries[idx][1] === value : removed) {
        return this;
      }
      SetRef(didAlter);
      (removed || !exists) && SetRef(didChangeSize);
      if (removed && entries.length === 1) {
        return ;
      }
      if (!exists && !removed && entries.length >= MAX_ARRAY_MAP_SIZE) {
        return createNodes(ownerID, entries, key, value);
      }
      var isEditable = ownerID && ownerID === this.ownerID;
      var newEntries = isEditable ? entries : arrCopy(entries);
      if (exists) {
        if (removed) {
          idx === len - 1 ? newEntries.pop() : (newEntries[idx] = newEntries.pop());
        } else {
          newEntries[idx] = [key, value];
        }
      } else {
        newEntries.push([key, value]);
      }
      if (isEditable) {
        this.entries = newEntries;
        return this;
      }
      return new ArrayMapNode(ownerID, newEntries);
    };
    function BitmapIndexedNode(ownerID, bitmap, nodes) {
      this.ownerID = ownerID;
      this.bitmap = bitmap;
      this.nodes = nodes;
    }
    BitmapIndexedNode.prototype.get = function(shift, keyHash, key, notSetValue) {
      if (keyHash === undefined) {
        keyHash = hash(key);
      }
      var bit = (1 << ((shift === 0 ? keyHash : keyHash >>> shift) & MASK));
      var bitmap = this.bitmap;
      return (bitmap & bit) === 0 ? notSetValue : this.nodes[popCount(bitmap & (bit - 1))].get(shift + SHIFT, keyHash, key, notSetValue);
    };
    BitmapIndexedNode.prototype.update = function(ownerID, shift, keyHash, key, value, didChangeSize, didAlter) {
      if (keyHash === undefined) {
        keyHash = hash(key);
      }
      var keyHashFrag = (shift === 0 ? keyHash : keyHash >>> shift) & MASK;
      var bit = 1 << keyHashFrag;
      var bitmap = this.bitmap;
      var exists = (bitmap & bit) !== 0;
      if (!exists && value === NOT_SET) {
        return this;
      }
      var idx = popCount(bitmap & (bit - 1));
      var nodes = this.nodes;
      var node = exists ? nodes[idx] : undefined;
      var newNode = updateNode(node, ownerID, shift + SHIFT, keyHash, key, value, didChangeSize, didAlter);
      if (newNode === node) {
        return this;
      }
      if (!exists && newNode && nodes.length >= MAX_BITMAP_INDEXED_SIZE) {
        return expandNodes(ownerID, nodes, bitmap, keyHashFrag, newNode);
      }
      if (exists && !newNode && nodes.length === 2 && isLeafNode(nodes[idx ^ 1])) {
        return nodes[idx ^ 1];
      }
      if (exists && newNode && nodes.length === 1 && isLeafNode(newNode)) {
        return newNode;
      }
      var isEditable = ownerID && ownerID === this.ownerID;
      var newBitmap = exists ? newNode ? bitmap : bitmap ^ bit : bitmap | bit;
      var newNodes = exists ? newNode ? setIn(nodes, idx, newNode, isEditable) : spliceOut(nodes, idx, isEditable) : spliceIn(nodes, idx, newNode, isEditable);
      if (isEditable) {
        this.bitmap = newBitmap;
        this.nodes = newNodes;
        return this;
      }
      return new BitmapIndexedNode(ownerID, newBitmap, newNodes);
    };
    function HashArrayMapNode(ownerID, count, nodes) {
      this.ownerID = ownerID;
      this.count = count;
      this.nodes = nodes;
    }
    HashArrayMapNode.prototype.get = function(shift, keyHash, key, notSetValue) {
      if (keyHash === undefined) {
        keyHash = hash(key);
      }
      var idx = (shift === 0 ? keyHash : keyHash >>> shift) & MASK;
      var node = this.nodes[idx];
      return node ? node.get(shift + SHIFT, keyHash, key, notSetValue) : notSetValue;
    };
    HashArrayMapNode.prototype.update = function(ownerID, shift, keyHash, key, value, didChangeSize, didAlter) {
      if (keyHash === undefined) {
        keyHash = hash(key);
      }
      var idx = (shift === 0 ? keyHash : keyHash >>> shift) & MASK;
      var removed = value === NOT_SET;
      var nodes = this.nodes;
      var node = nodes[idx];
      if (removed && !node) {
        return this;
      }
      var newNode = updateNode(node, ownerID, shift + SHIFT, keyHash, key, value, didChangeSize, didAlter);
      if (newNode === node) {
        return this;
      }
      var newCount = this.count;
      if (!node) {
        newCount++;
      } else if (!newNode) {
        newCount--;
        if (newCount < MIN_HASH_ARRAY_MAP_SIZE) {
          return packNodes(ownerID, nodes, newCount, idx);
        }
      }
      var isEditable = ownerID && ownerID === this.ownerID;
      var newNodes = setIn(nodes, idx, newNode, isEditable);
      if (isEditable) {
        this.count = newCount;
        this.nodes = newNodes;
        return this;
      }
      return new HashArrayMapNode(ownerID, newCount, newNodes);
    };
    function HashCollisionNode(ownerID, keyHash, entries) {
      this.ownerID = ownerID;
      this.keyHash = keyHash;
      this.entries = entries;
    }
    HashCollisionNode.prototype.get = function(shift, keyHash, key, notSetValue) {
      var entries = this.entries;
      for (var ii = 0,
          len = entries.length; ii < len; ii++) {
        if (is(key, entries[ii][0])) {
          return entries[ii][1];
        }
      }
      return notSetValue;
    };
    HashCollisionNode.prototype.update = function(ownerID, shift, keyHash, key, value, didChangeSize, didAlter) {
      if (keyHash === undefined) {
        keyHash = hash(key);
      }
      var removed = value === NOT_SET;
      if (keyHash !== this.keyHash) {
        if (removed) {
          return this;
        }
        SetRef(didAlter);
        SetRef(didChangeSize);
        return mergeIntoNode(this, ownerID, shift, keyHash, [key, value]);
      }
      var entries = this.entries;
      var idx = 0;
      for (var len = entries.length; idx < len; idx++) {
        if (is(key, entries[idx][0])) {
          break;
        }
      }
      var exists = idx < len;
      if (exists ? entries[idx][1] === value : removed) {
        return this;
      }
      SetRef(didAlter);
      (removed || !exists) && SetRef(didChangeSize);
      if (removed && len === 2) {
        return new ValueNode(ownerID, this.keyHash, entries[idx ^ 1]);
      }
      var isEditable = ownerID && ownerID === this.ownerID;
      var newEntries = isEditable ? entries : arrCopy(entries);
      if (exists) {
        if (removed) {
          idx === len - 1 ? newEntries.pop() : (newEntries[idx] = newEntries.pop());
        } else {
          newEntries[idx] = [key, value];
        }
      } else {
        newEntries.push([key, value]);
      }
      if (isEditable) {
        this.entries = newEntries;
        return this;
      }
      return new HashCollisionNode(ownerID, this.keyHash, newEntries);
    };
    function ValueNode(ownerID, keyHash, entry) {
      this.ownerID = ownerID;
      this.keyHash = keyHash;
      this.entry = entry;
    }
    ValueNode.prototype.get = function(shift, keyHash, key, notSetValue) {
      return is(key, this.entry[0]) ? this.entry[1] : notSetValue;
    };
    ValueNode.prototype.update = function(ownerID, shift, keyHash, key, value, didChangeSize, didAlter) {
      var removed = value === NOT_SET;
      var keyMatch = is(key, this.entry[0]);
      if (keyMatch ? value === this.entry[1] : removed) {
        return this;
      }
      SetRef(didAlter);
      if (removed) {
        SetRef(didChangeSize);
        return ;
      }
      if (keyMatch) {
        if (ownerID && ownerID === this.ownerID) {
          this.entry[1] = value;
          return this;
        }
        return new ValueNode(ownerID, this.keyHash, [key, value]);
      }
      SetRef(didChangeSize);
      return mergeIntoNode(this, ownerID, shift, hash(key), [key, value]);
    };
    ArrayMapNode.prototype.iterate = HashCollisionNode.prototype.iterate = function(fn, reverse) {
      var entries = this.entries;
      for (var ii = 0,
          maxIndex = entries.length - 1; ii <= maxIndex; ii++) {
        if (fn(entries[reverse ? maxIndex - ii : ii]) === false) {
          return false;
        }
      }
    };
    BitmapIndexedNode.prototype.iterate = HashArrayMapNode.prototype.iterate = function(fn, reverse) {
      var nodes = this.nodes;
      for (var ii = 0,
          maxIndex = nodes.length - 1; ii <= maxIndex; ii++) {
        var node = nodes[reverse ? maxIndex - ii : ii];
        if (node && node.iterate(fn, reverse) === false) {
          return false;
        }
      }
    };
    ValueNode.prototype.iterate = function(fn, reverse) {
      return fn(this.entry);
    };
    createClass(MapIterator, src_Iterator__Iterator);
    function MapIterator(map, type, reverse) {
      this._type = type;
      this._reverse = reverse;
      this._stack = map._root && mapIteratorFrame(map._root);
    }
    MapIterator.prototype.next = function() {
      var type = this._type;
      var stack = this._stack;
      while (stack) {
        var node = stack.node;
        var index = stack.index++;
        var maxIndex;
        if (node.entry) {
          if (index === 0) {
            return mapIteratorValue(type, node.entry);
          }
        } else if (node.entries) {
          maxIndex = node.entries.length - 1;
          if (index <= maxIndex) {
            return mapIteratorValue(type, node.entries[this._reverse ? maxIndex - index : index]);
          }
        } else {
          maxIndex = node.nodes.length - 1;
          if (index <= maxIndex) {
            var subNode = node.nodes[this._reverse ? maxIndex - index : index];
            if (subNode) {
              if (subNode.entry) {
                return mapIteratorValue(type, subNode.entry);
              }
              stack = this._stack = mapIteratorFrame(subNode, stack);
            }
            continue;
          }
        }
        stack = this._stack = this._stack.__prev;
      }
      return iteratorDone();
    };
    function mapIteratorValue(type, entry) {
      return iteratorValue(type, entry[0], entry[1]);
    }
    function mapIteratorFrame(node, prev) {
      return {
        node: node,
        index: 0,
        __prev: prev
      };
    }
    function makeMap(size, root, ownerID, hash) {
      var map = Object.create(MapPrototype);
      map.size = size;
      map._root = root;
      map.__ownerID = ownerID;
      map.__hash = hash;
      map.__altered = false;
      return map;
    }
    var EMPTY_MAP;
    function emptyMap() {
      return EMPTY_MAP || (EMPTY_MAP = makeMap(0));
    }
    function updateMap(map, k, v) {
      var newRoot;
      var newSize;
      if (!map._root) {
        if (v === NOT_SET) {
          return map;
        }
        newSize = 1;
        newRoot = new ArrayMapNode(map.__ownerID, [[k, v]]);
      } else {
        var didChangeSize = MakeRef(CHANGE_LENGTH);
        var didAlter = MakeRef(DID_ALTER);
        newRoot = updateNode(map._root, map.__ownerID, 0, undefined, k, v, didChangeSize, didAlter);
        if (!didAlter.value) {
          return map;
        }
        newSize = map.size + (didChangeSize.value ? v === NOT_SET ? -1 : 1 : 0);
      }
      if (map.__ownerID) {
        map.size = newSize;
        map._root = newRoot;
        map.__hash = undefined;
        map.__altered = true;
        return map;
      }
      return newRoot ? makeMap(newSize, newRoot) : emptyMap();
    }
    function updateNode(node, ownerID, shift, keyHash, key, value, didChangeSize, didAlter) {
      if (!node) {
        if (value === NOT_SET) {
          return node;
        }
        SetRef(didAlter);
        SetRef(didChangeSize);
        return new ValueNode(ownerID, keyHash, [key, value]);
      }
      return node.update(ownerID, shift, keyHash, key, value, didChangeSize, didAlter);
    }
    function isLeafNode(node) {
      return node.constructor === ValueNode || node.constructor === HashCollisionNode;
    }
    function mergeIntoNode(node, ownerID, shift, keyHash, entry) {
      if (node.keyHash === keyHash) {
        return new HashCollisionNode(ownerID, keyHash, [node.entry, entry]);
      }
      var idx1 = (shift === 0 ? node.keyHash : node.keyHash >>> shift) & MASK;
      var idx2 = (shift === 0 ? keyHash : keyHash >>> shift) & MASK;
      var newNode;
      var nodes = idx1 === idx2 ? [mergeIntoNode(node, ownerID, shift + SHIFT, keyHash, entry)] : ((newNode = new ValueNode(ownerID, keyHash, entry)), idx1 < idx2 ? [node, newNode] : [newNode, node]);
      return new BitmapIndexedNode(ownerID, (1 << idx1) | (1 << idx2), nodes);
    }
    function createNodes(ownerID, entries, key, value) {
      if (!ownerID) {
        ownerID = new OwnerID();
      }
      var node = new ValueNode(ownerID, hash(key), [key, value]);
      for (var ii = 0; ii < entries.length; ii++) {
        var entry = entries[ii];
        node = node.update(ownerID, 0, undefined, entry[0], entry[1]);
      }
      return node;
    }
    function packNodes(ownerID, nodes, count, excluding) {
      var bitmap = 0;
      var packedII = 0;
      var packedNodes = new Array(count);
      for (var ii = 0,
          bit = 1,
          len = nodes.length; ii < len; ii++, bit <<= 1) {
        var node = nodes[ii];
        if (node !== undefined && ii !== excluding) {
          bitmap |= bit;
          packedNodes[packedII++] = node;
        }
      }
      return new BitmapIndexedNode(ownerID, bitmap, packedNodes);
    }
    function expandNodes(ownerID, nodes, bitmap, including, node) {
      var count = 0;
      var expandedNodes = new Array(SIZE);
      for (var ii = 0; bitmap !== 0; ii++, bitmap >>>= 1) {
        expandedNodes[ii] = bitmap & 1 ? nodes[count++] : undefined;
      }
      expandedNodes[including] = node;
      return new HashArrayMapNode(ownerID, count + 1, expandedNodes);
    }
    function mergeIntoMapWith(map, merger, iterables) {
      var iters = [];
      for (var ii = 0; ii < iterables.length; ii++) {
        var value = iterables[ii];
        var iter = KeyedIterable(value);
        if (!isIterable(value)) {
          iter = iter.map(function(v) {
            return fromJS(v);
          });
        }
        iters.push(iter);
      }
      return mergeIntoCollectionWith(map, merger, iters);
    }
    function deepMerger(merger) {
      return function(existing, value, key) {
        return existing && existing.mergeDeepWith && isIterable(value) ? existing.mergeDeepWith(merger, value) : merger ? merger(existing, value, key) : value;
      };
    }
    function mergeIntoCollectionWith(collection, merger, iters) {
      iters = iters.filter(function(x) {
        return x.size !== 0;
      });
      if (iters.length === 0) {
        return collection;
      }
      if (collection.size === 0 && !collection.__ownerID && iters.length === 1) {
        return collection.constructor(iters[0]);
      }
      return collection.withMutations(function(collection) {
        var mergeIntoMap = merger ? function(value, key) {
          collection.update(key, NOT_SET, function(existing) {
            return existing === NOT_SET ? value : merger(existing, value, key);
          });
        } : function(value, key) {
          collection.set(key, value);
        };
        for (var ii = 0; ii < iters.length; ii++) {
          iters[ii].forEach(mergeIntoMap);
        }
      });
    }
    function updateInDeepMap(existing, keyPathIter, notSetValue, updater) {
      var isNotSet = existing === NOT_SET;
      var step = keyPathIter.next();
      if (step.done) {
        var existingValue = isNotSet ? notSetValue : existing;
        var newValue = updater(existingValue);
        return newValue === existingValue ? existing : newValue;
      }
      invariant(isNotSet || (existing && existing.set), 'invalid keyPath');
      var key = step.value;
      var nextExisting = isNotSet ? NOT_SET : existing.get(key, NOT_SET);
      var nextUpdated = updateInDeepMap(nextExisting, keyPathIter, notSetValue, updater);
      return nextUpdated === nextExisting ? existing : nextUpdated === NOT_SET ? existing.remove(key) : (isNotSet ? emptyMap() : existing).set(key, nextUpdated);
    }
    function popCount(x) {
      x = x - ((x >> 1) & 0x55555555);
      x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
      x = (x + (x >> 4)) & 0x0f0f0f0f;
      x = x + (x >> 8);
      x = x + (x >> 16);
      return x & 0x7f;
    }
    function setIn(array, idx, val, canEdit) {
      var newArray = canEdit ? array : arrCopy(array);
      newArray[idx] = val;
      return newArray;
    }
    function spliceIn(array, idx, val, canEdit) {
      var newLen = array.length + 1;
      if (canEdit && idx + 1 === newLen) {
        array[idx] = val;
        return array;
      }
      var newArray = new Array(newLen);
      var after = 0;
      for (var ii = 0; ii < newLen; ii++) {
        if (ii === idx) {
          newArray[ii] = val;
          after = -1;
        } else {
          newArray[ii] = array[ii + after];
        }
      }
      return newArray;
    }
    function spliceOut(array, idx, canEdit) {
      var newLen = array.length - 1;
      if (canEdit && idx === newLen) {
        array.pop();
        return array;
      }
      var newArray = new Array(newLen);
      var after = 0;
      for (var ii = 0; ii < newLen; ii++) {
        if (ii === idx) {
          after = 1;
        }
        newArray[ii] = array[ii + after];
      }
      return newArray;
    }
    var MAX_ARRAY_MAP_SIZE = SIZE / 4;
    var MAX_BITMAP_INDEXED_SIZE = SIZE / 2;
    var MIN_HASH_ARRAY_MAP_SIZE = SIZE / 4;
    createClass(List, IndexedCollection);
    function List(value) {
      var empty = emptyList();
      if (value === null || value === undefined) {
        return empty;
      }
      if (isList(value)) {
        return value;
      }
      var iter = IndexedIterable(value);
      var size = iter.size;
      if (size === 0) {
        return empty;
      }
      assertNotInfinite(size);
      if (size > 0 && size < SIZE) {
        return makeList(0, size, SHIFT, null, new VNode(iter.toArray()));
      }
      return empty.withMutations(function(list) {
        list.setSize(size);
        iter.forEach(function(v, i) {
          return list.set(i, v);
        });
      });
    }
    List.of = function() {
      return this(arguments);
    };
    List.prototype.toString = function() {
      return this.__toString('List [', ']');
    };
    List.prototype.get = function(index, notSetValue) {
      index = wrapIndex(this, index);
      if (index < 0 || index >= this.size) {
        return notSetValue;
      }
      index += this._origin;
      var node = listNodeFor(this, index);
      return node && node.array[index & MASK];
    };
    List.prototype.set = function(index, value) {
      return updateList(this, index, value);
    };
    List.prototype.remove = function(index) {
      return !this.has(index) ? this : index === 0 ? this.shift() : index === this.size - 1 ? this.pop() : this.splice(index, 1);
    };
    List.prototype.clear = function() {
      if (this.size === 0) {
        return this;
      }
      if (this.__ownerID) {
        this.size = this._origin = this._capacity = 0;
        this._level = SHIFT;
        this._root = this._tail = null;
        this.__hash = undefined;
        this.__altered = true;
        return this;
      }
      return emptyList();
    };
    List.prototype.push = function() {
      var values = arguments;
      var oldSize = this.size;
      return this.withMutations(function(list) {
        setListBounds(list, 0, oldSize + values.length);
        for (var ii = 0; ii < values.length; ii++) {
          list.set(oldSize + ii, values[ii]);
        }
      });
    };
    List.prototype.pop = function() {
      return setListBounds(this, 0, -1);
    };
    List.prototype.unshift = function() {
      var values = arguments;
      return this.withMutations(function(list) {
        setListBounds(list, -values.length);
        for (var ii = 0; ii < values.length; ii++) {
          list.set(ii, values[ii]);
        }
      });
    };
    List.prototype.shift = function() {
      return setListBounds(this, 1);
    };
    List.prototype.merge = function() {
      return mergeIntoListWith(this, undefined, arguments);
    };
    List.prototype.mergeWith = function(merger) {
      var iters = SLICE$0.call(arguments, 1);
      return mergeIntoListWith(this, merger, iters);
    };
    List.prototype.mergeDeep = function() {
      return mergeIntoListWith(this, deepMerger(undefined), arguments);
    };
    List.prototype.mergeDeepWith = function(merger) {
      var iters = SLICE$0.call(arguments, 1);
      return mergeIntoListWith(this, deepMerger(merger), iters);
    };
    List.prototype.setSize = function(size) {
      return setListBounds(this, 0, size);
    };
    List.prototype.slice = function(begin, end) {
      var size = this.size;
      if (wholeSlice(begin, end, size)) {
        return this;
      }
      return setListBounds(this, resolveBegin(begin, size), resolveEnd(end, size));
    };
    List.prototype.__iterator = function(type, reverse) {
      var index = 0;
      var values = iterateList(this, reverse);
      return new src_Iterator__Iterator(function() {
        var value = values();
        return value === DONE ? iteratorDone() : iteratorValue(type, index++, value);
      });
    };
    List.prototype.__iterate = function(fn, reverse) {
      var index = 0;
      var values = iterateList(this, reverse);
      var value;
      while ((value = values()) !== DONE) {
        if (fn(value, index++, this) === false) {
          break;
        }
      }
      return index;
    };
    List.prototype.__ensureOwner = function(ownerID) {
      if (ownerID === this.__ownerID) {
        return this;
      }
      if (!ownerID) {
        this.__ownerID = ownerID;
        return this;
      }
      return makeList(this._origin, this._capacity, this._level, this._root, this._tail, ownerID, this.__hash);
    };
    function isList(maybeList) {
      return !!(maybeList && maybeList[IS_LIST_SENTINEL]);
    }
    List.isList = isList;
    var IS_LIST_SENTINEL = '@@__IMMUTABLE_LIST__@@';
    var ListPrototype = List.prototype;
    ListPrototype[IS_LIST_SENTINEL] = true;
    ListPrototype[DELETE] = ListPrototype.remove;
    ListPrototype.setIn = MapPrototype.setIn;
    ListPrototype.deleteIn = ListPrototype.removeIn = MapPrototype.removeIn;
    ListPrototype.update = MapPrototype.update;
    ListPrototype.updateIn = MapPrototype.updateIn;
    ListPrototype.mergeIn = MapPrototype.mergeIn;
    ListPrototype.mergeDeepIn = MapPrototype.mergeDeepIn;
    ListPrototype.withMutations = MapPrototype.withMutations;
    ListPrototype.asMutable = MapPrototype.asMutable;
    ListPrototype.asImmutable = MapPrototype.asImmutable;
    ListPrototype.wasAltered = MapPrototype.wasAltered;
    function VNode(array, ownerID) {
      this.array = array;
      this.ownerID = ownerID;
    }
    VNode.prototype.removeBefore = function(ownerID, level, index) {
      if (index === level ? 1 << level : 0 || this.array.length === 0) {
        return this;
      }
      var originIndex = (index >>> level) & MASK;
      if (originIndex >= this.array.length) {
        return new VNode([], ownerID);
      }
      var removingFirst = originIndex === 0;
      var newChild;
      if (level > 0) {
        var oldChild = this.array[originIndex];
        newChild = oldChild && oldChild.removeBefore(ownerID, level - SHIFT, index);
        if (newChild === oldChild && removingFirst) {
          return this;
        }
      }
      if (removingFirst && !newChild) {
        return this;
      }
      var editable = editableVNode(this, ownerID);
      if (!removingFirst) {
        for (var ii = 0; ii < originIndex; ii++) {
          editable.array[ii] = undefined;
        }
      }
      if (newChild) {
        editable.array[originIndex] = newChild;
      }
      return editable;
    };
    VNode.prototype.removeAfter = function(ownerID, level, index) {
      if (index === level ? 1 << level : 0 || this.array.length === 0) {
        return this;
      }
      var sizeIndex = ((index - 1) >>> level) & MASK;
      if (sizeIndex >= this.array.length) {
        return this;
      }
      var removingLast = sizeIndex === this.array.length - 1;
      var newChild;
      if (level > 0) {
        var oldChild = this.array[sizeIndex];
        newChild = oldChild && oldChild.removeAfter(ownerID, level - SHIFT, index);
        if (newChild === oldChild && removingLast) {
          return this;
        }
      }
      if (removingLast && !newChild) {
        return this;
      }
      var editable = editableVNode(this, ownerID);
      if (!removingLast) {
        editable.array.pop();
      }
      if (newChild) {
        editable.array[sizeIndex] = newChild;
      }
      return editable;
    };
    var DONE = {};
    function iterateList(list, reverse) {
      var left = list._origin;
      var right = list._capacity;
      var tailPos = getTailOffset(right);
      var tail = list._tail;
      return iterateNodeOrLeaf(list._root, list._level, 0);
      function iterateNodeOrLeaf(node, level, offset) {
        return level === 0 ? iterateLeaf(node, offset) : iterateNode(node, level, offset);
      }
      function iterateLeaf(node, offset) {
        var array = offset === tailPos ? tail && tail.array : node && node.array;
        var from = offset > left ? 0 : left - offset;
        var to = right - offset;
        if (to > SIZE) {
          to = SIZE;
        }
        return function() {
          if (from === to) {
            return DONE;
          }
          var idx = reverse ? --to : from++;
          return array && array[idx];
        };
      }
      function iterateNode(node, level, offset) {
        var values;
        var array = node && node.array;
        var from = offset > left ? 0 : (left - offset) >> level;
        var to = ((right - offset) >> level) + 1;
        if (to > SIZE) {
          to = SIZE;
        }
        return function() {
          do {
            if (values) {
              var value = values();
              if (value !== DONE) {
                return value;
              }
              values = null;
            }
            if (from === to) {
              return DONE;
            }
            var idx = reverse ? --to : from++;
            values = iterateNodeOrLeaf(array && array[idx], level - SHIFT, offset + (idx << level));
          } while (true);
        };
      }
    }
    function makeList(origin, capacity, level, root, tail, ownerID, hash) {
      var list = Object.create(ListPrototype);
      list.size = capacity - origin;
      list._origin = origin;
      list._capacity = capacity;
      list._level = level;
      list._root = root;
      list._tail = tail;
      list.__ownerID = ownerID;
      list.__hash = hash;
      list.__altered = false;
      return list;
    }
    var EMPTY_LIST;
    function emptyList() {
      return EMPTY_LIST || (EMPTY_LIST = makeList(0, 0, SHIFT));
    }
    function updateList(list, index, value) {
      index = wrapIndex(list, index);
      if (index >= list.size || index < 0) {
        return list.withMutations(function(list) {
          index < 0 ? setListBounds(list, index).set(0, value) : setListBounds(list, 0, index + 1).set(index, value);
        });
      }
      index += list._origin;
      var newTail = list._tail;
      var newRoot = list._root;
      var didAlter = MakeRef(DID_ALTER);
      if (index >= getTailOffset(list._capacity)) {
        newTail = updateVNode(newTail, list.__ownerID, 0, index, value, didAlter);
      } else {
        newRoot = updateVNode(newRoot, list.__ownerID, list._level, index, value, didAlter);
      }
      if (!didAlter.value) {
        return list;
      }
      if (list.__ownerID) {
        list._root = newRoot;
        list._tail = newTail;
        list.__hash = undefined;
        list.__altered = true;
        return list;
      }
      return makeList(list._origin, list._capacity, list._level, newRoot, newTail);
    }
    function updateVNode(node, ownerID, level, index, value, didAlter) {
      var idx = (index >>> level) & MASK;
      var nodeHas = node && idx < node.array.length;
      if (!nodeHas && value === undefined) {
        return node;
      }
      var newNode;
      if (level > 0) {
        var lowerNode = node && node.array[idx];
        var newLowerNode = updateVNode(lowerNode, ownerID, level - SHIFT, index, value, didAlter);
        if (newLowerNode === lowerNode) {
          return node;
        }
        newNode = editableVNode(node, ownerID);
        newNode.array[idx] = newLowerNode;
        return newNode;
      }
      if (nodeHas && node.array[idx] === value) {
        return node;
      }
      SetRef(didAlter);
      newNode = editableVNode(node, ownerID);
      if (value === undefined && idx === newNode.array.length - 1) {
        newNode.array.pop();
      } else {
        newNode.array[idx] = value;
      }
      return newNode;
    }
    function editableVNode(node, ownerID) {
      if (ownerID && node && ownerID === node.ownerID) {
        return node;
      }
      return new VNode(node ? node.array.slice() : [], ownerID);
    }
    function listNodeFor(list, rawIndex) {
      if (rawIndex >= getTailOffset(list._capacity)) {
        return list._tail;
      }
      if (rawIndex < 1 << (list._level + SHIFT)) {
        var node = list._root;
        var level = list._level;
        while (node && level > 0) {
          node = node.array[(rawIndex >>> level) & MASK];
          level -= SHIFT;
        }
        return node;
      }
    }
    function setListBounds(list, begin, end) {
      var owner = list.__ownerID || new OwnerID();
      var oldOrigin = list._origin;
      var oldCapacity = list._capacity;
      var newOrigin = oldOrigin + begin;
      var newCapacity = end === undefined ? oldCapacity : end < 0 ? oldCapacity + end : oldOrigin + end;
      if (newOrigin === oldOrigin && newCapacity === oldCapacity) {
        return list;
      }
      if (newOrigin >= newCapacity) {
        return list.clear();
      }
      var newLevel = list._level;
      var newRoot = list._root;
      var offsetShift = 0;
      while (newOrigin + offsetShift < 0) {
        newRoot = new VNode(newRoot && newRoot.array.length ? [undefined, newRoot] : [], owner);
        newLevel += SHIFT;
        offsetShift += 1 << newLevel;
      }
      if (offsetShift) {
        newOrigin += offsetShift;
        oldOrigin += offsetShift;
        newCapacity += offsetShift;
        oldCapacity += offsetShift;
      }
      var oldTailOffset = getTailOffset(oldCapacity);
      var newTailOffset = getTailOffset(newCapacity);
      while (newTailOffset >= 1 << (newLevel + SHIFT)) {
        newRoot = new VNode(newRoot && newRoot.array.length ? [newRoot] : [], owner);
        newLevel += SHIFT;
      }
      var oldTail = list._tail;
      var newTail = newTailOffset < oldTailOffset ? listNodeFor(list, newCapacity - 1) : newTailOffset > oldTailOffset ? new VNode([], owner) : oldTail;
      if (oldTail && newTailOffset > oldTailOffset && newOrigin < oldCapacity && oldTail.array.length) {
        newRoot = editableVNode(newRoot, owner);
        var node = newRoot;
        for (var level = newLevel; level > SHIFT; level -= SHIFT) {
          var idx = (oldTailOffset >>> level) & MASK;
          node = node.array[idx] = editableVNode(node.array[idx], owner);
        }
        node.array[(oldTailOffset >>> SHIFT) & MASK] = oldTail;
      }
      if (newCapacity < oldCapacity) {
        newTail = newTail && newTail.removeAfter(owner, 0, newCapacity);
      }
      if (newOrigin >= newTailOffset) {
        newOrigin -= newTailOffset;
        newCapacity -= newTailOffset;
        newLevel = SHIFT;
        newRoot = null;
        newTail = newTail && newTail.removeBefore(owner, 0, newOrigin);
      } else if (newOrigin > oldOrigin || newTailOffset < oldTailOffset) {
        offsetShift = 0;
        while (newRoot) {
          var beginIndex = (newOrigin >>> newLevel) & MASK;
          if (beginIndex !== (newTailOffset >>> newLevel) & MASK) {
            break;
          }
          if (beginIndex) {
            offsetShift += (1 << newLevel) * beginIndex;
          }
          newLevel -= SHIFT;
          newRoot = newRoot.array[beginIndex];
        }
        if (newRoot && newOrigin > oldOrigin) {
          newRoot = newRoot.removeBefore(owner, newLevel, newOrigin - offsetShift);
        }
        if (newRoot && newTailOffset < oldTailOffset) {
          newRoot = newRoot.removeAfter(owner, newLevel, newTailOffset - offsetShift);
        }
        if (offsetShift) {
          newOrigin -= offsetShift;
          newCapacity -= offsetShift;
        }
      }
      if (list.__ownerID) {
        list.size = newCapacity - newOrigin;
        list._origin = newOrigin;
        list._capacity = newCapacity;
        list._level = newLevel;
        list._root = newRoot;
        list._tail = newTail;
        list.__hash = undefined;
        list.__altered = true;
        return list;
      }
      return makeList(newOrigin, newCapacity, newLevel, newRoot, newTail);
    }
    function mergeIntoListWith(list, merger, iterables) {
      var iters = [];
      var maxSize = 0;
      for (var ii = 0; ii < iterables.length; ii++) {
        var value = iterables[ii];
        var iter = IndexedIterable(value);
        if (iter.size > maxSize) {
          maxSize = iter.size;
        }
        if (!isIterable(value)) {
          iter = iter.map(function(v) {
            return fromJS(v);
          });
        }
        iters.push(iter);
      }
      if (maxSize > list.size) {
        list = list.setSize(maxSize);
      }
      return mergeIntoCollectionWith(list, merger, iters);
    }
    function getTailOffset(size) {
      return size < SIZE ? 0 : (((size - 1) >>> SHIFT) << SHIFT);
    }
    createClass(OrderedMap, src_Map__Map);
    function OrderedMap(value) {
      return value === null || value === undefined ? emptyOrderedMap() : isOrderedMap(value) ? value : emptyOrderedMap().withMutations(function(map) {
        var iter = KeyedIterable(value);
        assertNotInfinite(iter.size);
        iter.forEach(function(v, k) {
          return map.set(k, v);
        });
      });
    }
    OrderedMap.of = function() {
      return this(arguments);
    };
    OrderedMap.prototype.toString = function() {
      return this.__toString('OrderedMap {', '}');
    };
    OrderedMap.prototype.get = function(k, notSetValue) {
      var index = this._map.get(k);
      return index !== undefined ? this._list.get(index)[1] : notSetValue;
    };
    OrderedMap.prototype.clear = function() {
      if (this.size === 0) {
        return this;
      }
      if (this.__ownerID) {
        this.size = 0;
        this._map.clear();
        this._list.clear();
        return this;
      }
      return emptyOrderedMap();
    };
    OrderedMap.prototype.set = function(k, v) {
      return updateOrderedMap(this, k, v);
    };
    OrderedMap.prototype.remove = function(k) {
      return updateOrderedMap(this, k, NOT_SET);
    };
    OrderedMap.prototype.wasAltered = function() {
      return this._map.wasAltered() || this._list.wasAltered();
    };
    OrderedMap.prototype.__iterate = function(fn, reverse) {
      var this$0 = this;
      return this._list.__iterate(function(entry) {
        return entry && fn(entry[1], entry[0], this$0);
      }, reverse);
    };
    OrderedMap.prototype.__iterator = function(type, reverse) {
      return this._list.fromEntrySeq().__iterator(type, reverse);
    };
    OrderedMap.prototype.__ensureOwner = function(ownerID) {
      if (ownerID === this.__ownerID) {
        return this;
      }
      var newMap = this._map.__ensureOwner(ownerID);
      var newList = this._list.__ensureOwner(ownerID);
      if (!ownerID) {
        this.__ownerID = ownerID;
        this._map = newMap;
        this._list = newList;
        return this;
      }
      return makeOrderedMap(newMap, newList, ownerID, this.__hash);
    };
    function isOrderedMap(maybeOrderedMap) {
      return isMap(maybeOrderedMap) && isOrdered(maybeOrderedMap);
    }
    OrderedMap.isOrderedMap = isOrderedMap;
    OrderedMap.prototype[IS_ORDERED_SENTINEL] = true;
    OrderedMap.prototype[DELETE] = OrderedMap.prototype.remove;
    function makeOrderedMap(map, list, ownerID, hash) {
      var omap = Object.create(OrderedMap.prototype);
      omap.size = map ? map.size : 0;
      omap._map = map;
      omap._list = list;
      omap.__ownerID = ownerID;
      omap.__hash = hash;
      return omap;
    }
    var EMPTY_ORDERED_MAP;
    function emptyOrderedMap() {
      return EMPTY_ORDERED_MAP || (EMPTY_ORDERED_MAP = makeOrderedMap(emptyMap(), emptyList()));
    }
    function updateOrderedMap(omap, k, v) {
      var map = omap._map;
      var list = omap._list;
      var i = map.get(k);
      var has = i !== undefined;
      var newMap;
      var newList;
      if (v === NOT_SET) {
        if (!has) {
          return omap;
        }
        if (list.size >= SIZE && list.size >= map.size * 2) {
          newList = list.filter(function(entry, idx) {
            return entry !== undefined && i !== idx;
          });
          newMap = newList.toKeyedSeq().map(function(entry) {
            return entry[0];
          }).flip().toMap();
          if (omap.__ownerID) {
            newMap.__ownerID = newList.__ownerID = omap.__ownerID;
          }
        } else {
          newMap = map.remove(k);
          newList = i === list.size - 1 ? list.pop() : list.set(i, undefined);
        }
      } else {
        if (has) {
          if (v === list.get(i)[1]) {
            return omap;
          }
          newMap = map;
          newList = list.set(i, [k, v]);
        } else {
          newMap = map.set(k, list.size);
          newList = list.set(list.size, [k, v]);
        }
      }
      if (omap.__ownerID) {
        omap.size = newMap.size;
        omap._map = newMap;
        omap._list = newList;
        omap.__hash = undefined;
        return omap;
      }
      return makeOrderedMap(newMap, newList);
    }
    createClass(Stack, IndexedCollection);
    function Stack(value) {
      return value === null || value === undefined ? emptyStack() : isStack(value) ? value : emptyStack().unshiftAll(value);
    }
    Stack.of = function() {
      return this(arguments);
    };
    Stack.prototype.toString = function() {
      return this.__toString('Stack [', ']');
    };
    Stack.prototype.get = function(index, notSetValue) {
      var head = this._head;
      index = wrapIndex(this, index);
      while (head && index--) {
        head = head.next;
      }
      return head ? head.value : notSetValue;
    };
    Stack.prototype.peek = function() {
      return this._head && this._head.value;
    };
    Stack.prototype.push = function() {
      if (arguments.length === 0) {
        return this;
      }
      var newSize = this.size + arguments.length;
      var head = this._head;
      for (var ii = arguments.length - 1; ii >= 0; ii--) {
        head = {
          value: arguments[ii],
          next: head
        };
      }
      if (this.__ownerID) {
        this.size = newSize;
        this._head = head;
        this.__hash = undefined;
        this.__altered = true;
        return this;
      }
      return makeStack(newSize, head);
    };
    Stack.prototype.pushAll = function(iter) {
      iter = IndexedIterable(iter);
      if (iter.size === 0) {
        return this;
      }
      assertNotInfinite(iter.size);
      var newSize = this.size;
      var head = this._head;
      iter.reverse().forEach(function(value) {
        newSize++;
        head = {
          value: value,
          next: head
        };
      });
      if (this.__ownerID) {
        this.size = newSize;
        this._head = head;
        this.__hash = undefined;
        this.__altered = true;
        return this;
      }
      return makeStack(newSize, head);
    };
    Stack.prototype.pop = function() {
      return this.slice(1);
    };
    Stack.prototype.unshift = function() {
      return this.push.apply(this, arguments);
    };
    Stack.prototype.unshiftAll = function(iter) {
      return this.pushAll(iter);
    };
    Stack.prototype.shift = function() {
      return this.pop.apply(this, arguments);
    };
    Stack.prototype.clear = function() {
      if (this.size === 0) {
        return this;
      }
      if (this.__ownerID) {
        this.size = 0;
        this._head = undefined;
        this.__hash = undefined;
        this.__altered = true;
        return this;
      }
      return emptyStack();
    };
    Stack.prototype.slice = function(begin, end) {
      if (wholeSlice(begin, end, this.size)) {
        return this;
      }
      var resolvedBegin = resolveBegin(begin, this.size);
      var resolvedEnd = resolveEnd(end, this.size);
      if (resolvedEnd !== this.size) {
        return IndexedCollection.prototype.slice.call(this, begin, end);
      }
      var newSize = this.size - resolvedBegin;
      var head = this._head;
      while (resolvedBegin--) {
        head = head.next;
      }
      if (this.__ownerID) {
        this.size = newSize;
        this._head = head;
        this.__hash = undefined;
        this.__altered = true;
        return this;
      }
      return makeStack(newSize, head);
    };
    Stack.prototype.__ensureOwner = function(ownerID) {
      if (ownerID === this.__ownerID) {
        return this;
      }
      if (!ownerID) {
        this.__ownerID = ownerID;
        this.__altered = false;
        return this;
      }
      return makeStack(this.size, this._head, ownerID, this.__hash);
    };
    Stack.prototype.__iterate = function(fn, reverse) {
      if (reverse) {
        return this.reverse().__iterate(fn);
      }
      var iterations = 0;
      var node = this._head;
      while (node) {
        if (fn(node.value, iterations++, this) === false) {
          break;
        }
        node = node.next;
      }
      return iterations;
    };
    Stack.prototype.__iterator = function(type, reverse) {
      if (reverse) {
        return this.reverse().__iterator(type);
      }
      var iterations = 0;
      var node = this._head;
      return new src_Iterator__Iterator(function() {
        if (node) {
          var value = node.value;
          node = node.next;
          return iteratorValue(type, iterations++, value);
        }
        return iteratorDone();
      });
    };
    function isStack(maybeStack) {
      return !!(maybeStack && maybeStack[IS_STACK_SENTINEL]);
    }
    Stack.isStack = isStack;
    var IS_STACK_SENTINEL = '@@__IMMUTABLE_STACK__@@';
    var StackPrototype = Stack.prototype;
    StackPrototype[IS_STACK_SENTINEL] = true;
    StackPrototype.withMutations = MapPrototype.withMutations;
    StackPrototype.asMutable = MapPrototype.asMutable;
    StackPrototype.asImmutable = MapPrototype.asImmutable;
    StackPrototype.wasAltered = MapPrototype.wasAltered;
    function makeStack(size, head, ownerID, hash) {
      var map = Object.create(StackPrototype);
      map.size = size;
      map._head = head;
      map.__ownerID = ownerID;
      map.__hash = hash;
      map.__altered = false;
      return map;
    }
    var EMPTY_STACK;
    function emptyStack() {
      return EMPTY_STACK || (EMPTY_STACK = makeStack(0));
    }
    createClass(src_Set__Set, SetCollection);
    function src_Set__Set(value) {
      return value === null || value === undefined ? emptySet() : isSet(value) ? value : emptySet().withMutations(function(set) {
        var iter = SetIterable(value);
        assertNotInfinite(iter.size);
        iter.forEach(function(v) {
          return set.add(v);
        });
      });
    }
    src_Set__Set.of = function() {
      return this(arguments);
    };
    src_Set__Set.fromKeys = function(value) {
      return this(KeyedIterable(value).keySeq());
    };
    src_Set__Set.prototype.toString = function() {
      return this.__toString('Set {', '}');
    };
    src_Set__Set.prototype.has = function(value) {
      return this._map.has(value);
    };
    src_Set__Set.prototype.add = function(value) {
      return updateSet(this, this._map.set(value, true));
    };
    src_Set__Set.prototype.remove = function(value) {
      return updateSet(this, this._map.remove(value));
    };
    src_Set__Set.prototype.clear = function() {
      return updateSet(this, this._map.clear());
    };
    src_Set__Set.prototype.union = function() {
      var iters = SLICE$0.call(arguments, 0);
      iters = iters.filter(function(x) {
        return x.size !== 0;
      });
      if (iters.length === 0) {
        return this;
      }
      if (this.size === 0 && !this.__ownerID && iters.length === 1) {
        return this.constructor(iters[0]);
      }
      return this.withMutations(function(set) {
        for (var ii = 0; ii < iters.length; ii++) {
          SetIterable(iters[ii]).forEach(function(value) {
            return set.add(value);
          });
        }
      });
    };
    src_Set__Set.prototype.intersect = function() {
      var iters = SLICE$0.call(arguments, 0);
      if (iters.length === 0) {
        return this;
      }
      iters = iters.map(function(iter) {
        return SetIterable(iter);
      });
      var originalSet = this;
      return this.withMutations(function(set) {
        originalSet.forEach(function(value) {
          if (!iters.every(function(iter) {
            return iter.includes(value);
          })) {
            set.remove(value);
          }
        });
      });
    };
    src_Set__Set.prototype.subtract = function() {
      var iters = SLICE$0.call(arguments, 0);
      if (iters.length === 0) {
        return this;
      }
      iters = iters.map(function(iter) {
        return SetIterable(iter);
      });
      var originalSet = this;
      return this.withMutations(function(set) {
        originalSet.forEach(function(value) {
          if (iters.some(function(iter) {
            return iter.includes(value);
          })) {
            set.remove(value);
          }
        });
      });
    };
    src_Set__Set.prototype.merge = function() {
      return this.union.apply(this, arguments);
    };
    src_Set__Set.prototype.mergeWith = function(merger) {
      var iters = SLICE$0.call(arguments, 1);
      return this.union.apply(this, iters);
    };
    src_Set__Set.prototype.sort = function(comparator) {
      return OrderedSet(sortFactory(this, comparator));
    };
    src_Set__Set.prototype.sortBy = function(mapper, comparator) {
      return OrderedSet(sortFactory(this, comparator, mapper));
    };
    src_Set__Set.prototype.wasAltered = function() {
      return this._map.wasAltered();
    };
    src_Set__Set.prototype.__iterate = function(fn, reverse) {
      var this$0 = this;
      return this._map.__iterate(function(_, k) {
        return fn(k, k, this$0);
      }, reverse);
    };
    src_Set__Set.prototype.__iterator = function(type, reverse) {
      return this._map.map(function(_, k) {
        return k;
      }).__iterator(type, reverse);
    };
    src_Set__Set.prototype.__ensureOwner = function(ownerID) {
      if (ownerID === this.__ownerID) {
        return this;
      }
      var newMap = this._map.__ensureOwner(ownerID);
      if (!ownerID) {
        this.__ownerID = ownerID;
        this._map = newMap;
        return this;
      }
      return this.__make(newMap, ownerID);
    };
    function isSet(maybeSet) {
      return !!(maybeSet && maybeSet[IS_SET_SENTINEL]);
    }
    src_Set__Set.isSet = isSet;
    var IS_SET_SENTINEL = '@@__IMMUTABLE_SET__@@';
    var SetPrototype = src_Set__Set.prototype;
    SetPrototype[IS_SET_SENTINEL] = true;
    SetPrototype[DELETE] = SetPrototype.remove;
    SetPrototype.mergeDeep = SetPrototype.merge;
    SetPrototype.mergeDeepWith = SetPrototype.mergeWith;
    SetPrototype.withMutations = MapPrototype.withMutations;
    SetPrototype.asMutable = MapPrototype.asMutable;
    SetPrototype.asImmutable = MapPrototype.asImmutable;
    SetPrototype.__empty = emptySet;
    SetPrototype.__make = makeSet;
    function updateSet(set, newMap) {
      if (set.__ownerID) {
        set.size = newMap.size;
        set._map = newMap;
        return set;
      }
      return newMap === set._map ? set : newMap.size === 0 ? set.__empty() : set.__make(newMap);
    }
    function makeSet(map, ownerID) {
      var set = Object.create(SetPrototype);
      set.size = map ? map.size : 0;
      set._map = map;
      set.__ownerID = ownerID;
      return set;
    }
    var EMPTY_SET;
    function emptySet() {
      return EMPTY_SET || (EMPTY_SET = makeSet(emptyMap()));
    }
    createClass(OrderedSet, src_Set__Set);
    function OrderedSet(value) {
      return value === null || value === undefined ? emptyOrderedSet() : isOrderedSet(value) ? value : emptyOrderedSet().withMutations(function(set) {
        var iter = SetIterable(value);
        assertNotInfinite(iter.size);
        iter.forEach(function(v) {
          return set.add(v);
        });
      });
    }
    OrderedSet.of = function() {
      return this(arguments);
    };
    OrderedSet.fromKeys = function(value) {
      return this(KeyedIterable(value).keySeq());
    };
    OrderedSet.prototype.toString = function() {
      return this.__toString('OrderedSet {', '}');
    };
    function isOrderedSet(maybeOrderedSet) {
      return isSet(maybeOrderedSet) && isOrdered(maybeOrderedSet);
    }
    OrderedSet.isOrderedSet = isOrderedSet;
    var OrderedSetPrototype = OrderedSet.prototype;
    OrderedSetPrototype[IS_ORDERED_SENTINEL] = true;
    OrderedSetPrototype.__empty = emptyOrderedSet;
    OrderedSetPrototype.__make = makeOrderedSet;
    function makeOrderedSet(map, ownerID) {
      var set = Object.create(OrderedSetPrototype);
      set.size = map ? map.size : 0;
      set._map = map;
      set.__ownerID = ownerID;
      return set;
    }
    var EMPTY_ORDERED_SET;
    function emptyOrderedSet() {
      return EMPTY_ORDERED_SET || (EMPTY_ORDERED_SET = makeOrderedSet(emptyOrderedMap()));
    }
    createClass(Record, KeyedCollection);
    function Record(defaultValues, name) {
      var hasInitialized;
      var RecordType = function Record(values) {
        if (values instanceof RecordType) {
          return values;
        }
        if (!(this instanceof RecordType)) {
          return new RecordType(values);
        }
        if (!hasInitialized) {
          hasInitialized = true;
          var keys = Object.keys(defaultValues);
          setProps(RecordTypePrototype, keys);
          RecordTypePrototype.size = keys.length;
          RecordTypePrototype._name = name;
          RecordTypePrototype._keys = keys;
          RecordTypePrototype._defaultValues = defaultValues;
        }
        this._map = src_Map__Map(values);
      };
      var RecordTypePrototype = RecordType.prototype = Object.create(RecordPrototype);
      RecordTypePrototype.constructor = RecordType;
      return RecordType;
    }
    Record.prototype.toString = function() {
      return this.__toString(recordName(this) + ' {', '}');
    };
    Record.prototype.has = function(k) {
      return this._defaultValues.hasOwnProperty(k);
    };
    Record.prototype.get = function(k, notSetValue) {
      if (!this.has(k)) {
        return notSetValue;
      }
      var defaultVal = this._defaultValues[k];
      return this._map ? this._map.get(k, defaultVal) : defaultVal;
    };
    Record.prototype.clear = function() {
      if (this.__ownerID) {
        this._map && this._map.clear();
        return this;
      }
      var RecordType = this.constructor;
      return RecordType._empty || (RecordType._empty = makeRecord(this, emptyMap()));
    };
    Record.prototype.set = function(k, v) {
      if (!this.has(k)) {
        throw new Error('Cannot set unknown key "' + k + '" on ' + recordName(this));
      }
      var newMap = this._map && this._map.set(k, v);
      if (this.__ownerID || newMap === this._map) {
        return this;
      }
      return makeRecord(this, newMap);
    };
    Record.prototype.remove = function(k) {
      if (!this.has(k)) {
        return this;
      }
      var newMap = this._map && this._map.remove(k);
      if (this.__ownerID || newMap === this._map) {
        return this;
      }
      return makeRecord(this, newMap);
    };
    Record.prototype.wasAltered = function() {
      return this._map.wasAltered();
    };
    Record.prototype.__iterator = function(type, reverse) {
      var this$0 = this;
      return KeyedIterable(this._defaultValues).map(function(_, k) {
        return this$0.get(k);
      }).__iterator(type, reverse);
    };
    Record.prototype.__iterate = function(fn, reverse) {
      var this$0 = this;
      return KeyedIterable(this._defaultValues).map(function(_, k) {
        return this$0.get(k);
      }).__iterate(fn, reverse);
    };
    Record.prototype.__ensureOwner = function(ownerID) {
      if (ownerID === this.__ownerID) {
        return this;
      }
      var newMap = this._map && this._map.__ensureOwner(ownerID);
      if (!ownerID) {
        this.__ownerID = ownerID;
        this._map = newMap;
        return this;
      }
      return makeRecord(this, newMap, ownerID);
    };
    var RecordPrototype = Record.prototype;
    RecordPrototype[DELETE] = RecordPrototype.remove;
    RecordPrototype.deleteIn = RecordPrototype.removeIn = MapPrototype.removeIn;
    RecordPrototype.merge = MapPrototype.merge;
    RecordPrototype.mergeWith = MapPrototype.mergeWith;
    RecordPrototype.mergeIn = MapPrototype.mergeIn;
    RecordPrototype.mergeDeep = MapPrototype.mergeDeep;
    RecordPrototype.mergeDeepWith = MapPrototype.mergeDeepWith;
    RecordPrototype.mergeDeepIn = MapPrototype.mergeDeepIn;
    RecordPrototype.setIn = MapPrototype.setIn;
    RecordPrototype.update = MapPrototype.update;
    RecordPrototype.updateIn = MapPrototype.updateIn;
    RecordPrototype.withMutations = MapPrototype.withMutations;
    RecordPrototype.asMutable = MapPrototype.asMutable;
    RecordPrototype.asImmutable = MapPrototype.asImmutable;
    function makeRecord(likeRecord, map, ownerID) {
      var record = Object.create(Object.getPrototypeOf(likeRecord));
      record._map = map;
      record.__ownerID = ownerID;
      return record;
    }
    function recordName(record) {
      return record._name || record.constructor.name || 'Record';
    }
    function setProps(prototype, names) {
      try {
        names.forEach(setProp.bind(undefined, prototype));
      } catch (error) {}
    }
    function setProp(prototype, name) {
      Object.defineProperty(prototype, name, {
        get: function() {
          return this.get(name);
        },
        set: function(value) {
          invariant(this.__ownerID, 'Cannot set on an immutable record.');
          this.set(name, value);
        }
      });
    }
    function deepEqual(a, b) {
      if (a === b) {
        return true;
      }
      if (!isIterable(b) || a.size !== undefined && b.size !== undefined && a.size !== b.size || a.__hash !== undefined && b.__hash !== undefined && a.__hash !== b.__hash || isKeyed(a) !== isKeyed(b) || isIndexed(a) !== isIndexed(b) || isOrdered(a) !== isOrdered(b)) {
        return false;
      }
      if (a.size === 0 && b.size === 0) {
        return true;
      }
      var notAssociative = !isAssociative(a);
      if (isOrdered(a)) {
        var entries = a.entries();
        return b.every(function(v, k) {
          var entry = entries.next().value;
          return entry && is(entry[1], v) && (notAssociative || is(entry[0], k));
        }) && entries.next().done;
      }
      var flipped = false;
      if (a.size === undefined) {
        if (b.size === undefined) {
          if (typeof a.cacheResult === 'function') {
            a.cacheResult();
          }
        } else {
          flipped = true;
          var _ = a;
          a = b;
          b = _;
        }
      }
      var allEqual = true;
      var bSize = b.__iterate(function(v, k) {
        if (notAssociative ? !a.has(v) : flipped ? !is(v, a.get(k, NOT_SET)) : !is(a.get(k, NOT_SET), v)) {
          allEqual = false;
          return false;
        }
      });
      return allEqual && a.size === bSize;
    }
    createClass(Range, IndexedSeq);
    function Range(start, end, step) {
      if (!(this instanceof Range)) {
        return new Range(start, end, step);
      }
      invariant(step !== 0, 'Cannot step a Range by 0');
      start = start || 0;
      if (end === undefined) {
        end = Infinity;
      }
      step = step === undefined ? 1 : Math.abs(step);
      if (end < start) {
        step = -step;
      }
      this._start = start;
      this._end = end;
      this._step = step;
      this.size = Math.max(0, Math.ceil((end - start) / step - 1) + 1);
      if (this.size === 0) {
        if (EMPTY_RANGE) {
          return EMPTY_RANGE;
        }
        EMPTY_RANGE = this;
      }
    }
    Range.prototype.toString = function() {
      if (this.size === 0) {
        return 'Range []';
      }
      return 'Range [ ' + this._start + '...' + this._end + (this._step > 1 ? ' by ' + this._step : '') + ' ]';
    };
    Range.prototype.get = function(index, notSetValue) {
      return this.has(index) ? this._start + wrapIndex(this, index) * this._step : notSetValue;
    };
    Range.prototype.includes = function(searchValue) {
      var possibleIndex = (searchValue - this._start) / this._step;
      return possibleIndex >= 0 && possibleIndex < this.size && possibleIndex === Math.floor(possibleIndex);
    };
    Range.prototype.slice = function(begin, end) {
      if (wholeSlice(begin, end, this.size)) {
        return this;
      }
      begin = resolveBegin(begin, this.size);
      end = resolveEnd(end, this.size);
      if (end <= begin) {
        return new Range(0, 0);
      }
      return new Range(this.get(begin, this._end), this.get(end, this._end), this._step);
    };
    Range.prototype.indexOf = function(searchValue) {
      var offsetValue = searchValue - this._start;
      if (offsetValue % this._step === 0) {
        var index = offsetValue / this._step;
        if (index >= 0 && index < this.size) {
          return index;
        }
      }
      return -1;
    };
    Range.prototype.lastIndexOf = function(searchValue) {
      return this.indexOf(searchValue);
    };
    Range.prototype.__iterate = function(fn, reverse) {
      var maxIndex = this.size - 1;
      var step = this._step;
      var value = reverse ? this._start + maxIndex * step : this._start;
      for (var ii = 0; ii <= maxIndex; ii++) {
        if (fn(value, ii, this) === false) {
          return ii + 1;
        }
        value += reverse ? -step : step;
      }
      return ii;
    };
    Range.prototype.__iterator = function(type, reverse) {
      var maxIndex = this.size - 1;
      var step = this._step;
      var value = reverse ? this._start + maxIndex * step : this._start;
      var ii = 0;
      return new src_Iterator__Iterator(function() {
        var v = value;
        value += reverse ? -step : step;
        return ii > maxIndex ? iteratorDone() : iteratorValue(type, ii++, v);
      });
    };
    Range.prototype.equals = function(other) {
      return other instanceof Range ? this._start === other._start && this._end === other._end && this._step === other._step : deepEqual(this, other);
    };
    var EMPTY_RANGE;
    createClass(Repeat, IndexedSeq);
    function Repeat(value, times) {
      if (!(this instanceof Repeat)) {
        return new Repeat(value, times);
      }
      this._value = value;
      this.size = times === undefined ? Infinity : Math.max(0, times);
      if (this.size === 0) {
        if (EMPTY_REPEAT) {
          return EMPTY_REPEAT;
        }
        EMPTY_REPEAT = this;
      }
    }
    Repeat.prototype.toString = function() {
      if (this.size === 0) {
        return 'Repeat []';
      }
      return 'Repeat [ ' + this._value + ' ' + this.size + ' times ]';
    };
    Repeat.prototype.get = function(index, notSetValue) {
      return this.has(index) ? this._value : notSetValue;
    };
    Repeat.prototype.includes = function(searchValue) {
      return is(this._value, searchValue);
    };
    Repeat.prototype.slice = function(begin, end) {
      var size = this.size;
      return wholeSlice(begin, end, size) ? this : new Repeat(this._value, resolveEnd(end, size) - resolveBegin(begin, size));
    };
    Repeat.prototype.reverse = function() {
      return this;
    };
    Repeat.prototype.indexOf = function(searchValue) {
      if (is(this._value, searchValue)) {
        return 0;
      }
      return -1;
    };
    Repeat.prototype.lastIndexOf = function(searchValue) {
      if (is(this._value, searchValue)) {
        return this.size;
      }
      return -1;
    };
    Repeat.prototype.__iterate = function(fn, reverse) {
      for (var ii = 0; ii < this.size; ii++) {
        if (fn(this._value, ii, this) === false) {
          return ii + 1;
        }
      }
      return ii;
    };
    Repeat.prototype.__iterator = function(type, reverse) {
      var this$0 = this;
      var ii = 0;
      return new src_Iterator__Iterator(function() {
        return ii < this$0.size ? iteratorValue(type, ii++, this$0._value) : iteratorDone();
      });
    };
    Repeat.prototype.equals = function(other) {
      return other instanceof Repeat ? is(this._value, other._value) : deepEqual(other);
    };
    var EMPTY_REPEAT;
    function mixin(ctor, methods) {
      var keyCopier = function(key) {
        ctor.prototype[key] = methods[key];
      };
      Object.keys(methods).forEach(keyCopier);
      Object.getOwnPropertySymbols && Object.getOwnPropertySymbols(methods).forEach(keyCopier);
      return ctor;
    }
    Iterable.Iterator = src_Iterator__Iterator;
    mixin(Iterable, {
      toArray: function() {
        assertNotInfinite(this.size);
        var array = new Array(this.size || 0);
        this.valueSeq().__iterate(function(v, i) {
          array[i] = v;
        });
        return array;
      },
      toIndexedSeq: function() {
        return new ToIndexedSequence(this);
      },
      toJS: function() {
        return this.toSeq().map(function(value) {
          return value && typeof value.toJS === 'function' ? value.toJS() : value;
        }).__toJS();
      },
      toJSON: function() {
        return this.toSeq().map(function(value) {
          return value && typeof value.toJSON === 'function' ? value.toJSON() : value;
        }).__toJS();
      },
      toKeyedSeq: function() {
        return new ToKeyedSequence(this, true);
      },
      toMap: function() {
        return src_Map__Map(this.toKeyedSeq());
      },
      toObject: function() {
        assertNotInfinite(this.size);
        var object = {};
        this.__iterate(function(v, k) {
          object[k] = v;
        });
        return object;
      },
      toOrderedMap: function() {
        return OrderedMap(this.toKeyedSeq());
      },
      toOrderedSet: function() {
        return OrderedSet(isKeyed(this) ? this.valueSeq() : this);
      },
      toSet: function() {
        return src_Set__Set(isKeyed(this) ? this.valueSeq() : this);
      },
      toSetSeq: function() {
        return new ToSetSequence(this);
      },
      toSeq: function() {
        return isIndexed(this) ? this.toIndexedSeq() : isKeyed(this) ? this.toKeyedSeq() : this.toSetSeq();
      },
      toStack: function() {
        return Stack(isKeyed(this) ? this.valueSeq() : this);
      },
      toList: function() {
        return List(isKeyed(this) ? this.valueSeq() : this);
      },
      toString: function() {
        return '[Iterable]';
      },
      __toString: function(head, tail) {
        if (this.size === 0) {
          return head + tail;
        }
        return head + ' ' + this.toSeq().map(this.__toStringMapper).join(', ') + ' ' + tail;
      },
      concat: function() {
        var values = SLICE$0.call(arguments, 0);
        return reify(this, concatFactory(this, values));
      },
      contains: function(searchValue) {
        return this.includes(searchValue);
      },
      includes: function(searchValue) {
        return this.some(function(value) {
          return is(value, searchValue);
        });
      },
      entries: function() {
        return this.__iterator(ITERATE_ENTRIES);
      },
      every: function(predicate, context) {
        assertNotInfinite(this.size);
        var returnValue = true;
        this.__iterate(function(v, k, c) {
          if (!predicate.call(context, v, k, c)) {
            returnValue = false;
            return false;
          }
        });
        return returnValue;
      },
      filter: function(predicate, context) {
        return reify(this, filterFactory(this, predicate, context, true));
      },
      find: function(predicate, context, notSetValue) {
        var entry = this.findEntry(predicate, context);
        return entry ? entry[1] : notSetValue;
      },
      findEntry: function(predicate, context) {
        var found;
        this.__iterate(function(v, k, c) {
          if (predicate.call(context, v, k, c)) {
            found = [k, v];
            return false;
          }
        });
        return found;
      },
      findLastEntry: function(predicate, context) {
        return this.toSeq().reverse().findEntry(predicate, context);
      },
      forEach: function(sideEffect, context) {
        assertNotInfinite(this.size);
        return this.__iterate(context ? sideEffect.bind(context) : sideEffect);
      },
      join: function(separator) {
        assertNotInfinite(this.size);
        separator = separator !== undefined ? '' + separator : ',';
        var joined = '';
        var isFirst = true;
        this.__iterate(function(v) {
          isFirst ? (isFirst = false) : (joined += separator);
          joined += v !== null && v !== undefined ? v.toString() : '';
        });
        return joined;
      },
      keys: function() {
        return this.__iterator(ITERATE_KEYS);
      },
      map: function(mapper, context) {
        return reify(this, mapFactory(this, mapper, context));
      },
      reduce: function(reducer, initialReduction, context) {
        assertNotInfinite(this.size);
        var reduction;
        var useFirst;
        if (arguments.length < 2) {
          useFirst = true;
        } else {
          reduction = initialReduction;
        }
        this.__iterate(function(v, k, c) {
          if (useFirst) {
            useFirst = false;
            reduction = v;
          } else {
            reduction = reducer.call(context, reduction, v, k, c);
          }
        });
        return reduction;
      },
      reduceRight: function(reducer, initialReduction, context) {
        var reversed = this.toKeyedSeq().reverse();
        return reversed.reduce.apply(reversed, arguments);
      },
      reverse: function() {
        return reify(this, reverseFactory(this, true));
      },
      slice: function(begin, end) {
        return reify(this, sliceFactory(this, begin, end, true));
      },
      some: function(predicate, context) {
        return !this.every(not(predicate), context);
      },
      sort: function(comparator) {
        return reify(this, sortFactory(this, comparator));
      },
      values: function() {
        return this.__iterator(ITERATE_VALUES);
      },
      butLast: function() {
        return this.slice(0, -1);
      },
      isEmpty: function() {
        return this.size !== undefined ? this.size === 0 : !this.some(function() {
          return true;
        });
      },
      count: function(predicate, context) {
        return ensureSize(predicate ? this.toSeq().filter(predicate, context) : this);
      },
      countBy: function(grouper, context) {
        return countByFactory(this, grouper, context);
      },
      equals: function(other) {
        return deepEqual(this, other);
      },
      entrySeq: function() {
        var iterable = this;
        if (iterable._cache) {
          return new ArraySeq(iterable._cache);
        }
        var entriesSequence = iterable.toSeq().map(entryMapper).toIndexedSeq();
        entriesSequence.fromEntrySeq = function() {
          return iterable.toSeq();
        };
        return entriesSequence;
      },
      filterNot: function(predicate, context) {
        return this.filter(not(predicate), context);
      },
      findLast: function(predicate, context, notSetValue) {
        return this.toKeyedSeq().reverse().find(predicate, context, notSetValue);
      },
      first: function() {
        return this.find(returnTrue);
      },
      flatMap: function(mapper, context) {
        return reify(this, flatMapFactory(this, mapper, context));
      },
      flatten: function(depth) {
        return reify(this, flattenFactory(this, depth, true));
      },
      fromEntrySeq: function() {
        return new FromEntriesSequence(this);
      },
      get: function(searchKey, notSetValue) {
        return this.find(function(_, key) {
          return is(key, searchKey);
        }, undefined, notSetValue);
      },
      getIn: function(searchKeyPath, notSetValue) {
        var nested = this;
        var iter = forceIterator(searchKeyPath);
        var step;
        while (!(step = iter.next()).done) {
          var key = step.value;
          nested = nested && nested.get ? nested.get(key, NOT_SET) : NOT_SET;
          if (nested === NOT_SET) {
            return notSetValue;
          }
        }
        return nested;
      },
      groupBy: function(grouper, context) {
        return groupByFactory(this, grouper, context);
      },
      has: function(searchKey) {
        return this.get(searchKey, NOT_SET) !== NOT_SET;
      },
      hasIn: function(searchKeyPath) {
        return this.getIn(searchKeyPath, NOT_SET) !== NOT_SET;
      },
      isSubset: function(iter) {
        iter = typeof iter.includes === 'function' ? iter : Iterable(iter);
        return this.every(function(value) {
          return iter.includes(value);
        });
      },
      isSuperset: function(iter) {
        return iter.isSubset(this);
      },
      keySeq: function() {
        return this.toSeq().map(keyMapper).toIndexedSeq();
      },
      last: function() {
        return this.toSeq().reverse().first();
      },
      max: function(comparator) {
        return maxFactory(this, comparator);
      },
      maxBy: function(mapper, comparator) {
        return maxFactory(this, comparator, mapper);
      },
      min: function(comparator) {
        return maxFactory(this, comparator ? neg(comparator) : defaultNegComparator);
      },
      minBy: function(mapper, comparator) {
        return maxFactory(this, comparator ? neg(comparator) : defaultNegComparator, mapper);
      },
      rest: function() {
        return this.slice(1);
      },
      skip: function(amount) {
        return this.slice(Math.max(0, amount));
      },
      skipLast: function(amount) {
        return reify(this, this.toSeq().reverse().skip(amount).reverse());
      },
      skipWhile: function(predicate, context) {
        return reify(this, skipWhileFactory(this, predicate, context, true));
      },
      skipUntil: function(predicate, context) {
        return this.skipWhile(not(predicate), context);
      },
      sortBy: function(mapper, comparator) {
        return reify(this, sortFactory(this, comparator, mapper));
      },
      take: function(amount) {
        return this.slice(0, Math.max(0, amount));
      },
      takeLast: function(amount) {
        return reify(this, this.toSeq().reverse().take(amount).reverse());
      },
      takeWhile: function(predicate, context) {
        return reify(this, takeWhileFactory(this, predicate, context));
      },
      takeUntil: function(predicate, context) {
        return this.takeWhile(not(predicate), context);
      },
      valueSeq: function() {
        return this.toIndexedSeq();
      },
      hashCode: function() {
        return this.__hash || (this.__hash = hashIterable(this));
      }
    });
    var IterablePrototype = Iterable.prototype;
    IterablePrototype[IS_ITERABLE_SENTINEL] = true;
    IterablePrototype[ITERATOR_SYMBOL] = IterablePrototype.values;
    IterablePrototype.__toJS = IterablePrototype.toArray;
    IterablePrototype.__toStringMapper = quoteString;
    IterablePrototype.inspect = IterablePrototype.toSource = function() {
      return this.toString();
    };
    IterablePrototype.chain = IterablePrototype.flatMap;
    (function() {
      try {
        Object.defineProperty(IterablePrototype, 'length', {get: function() {
            if (!Iterable.noLengthWarning) {
              var stack;
              try {
                throw new Error();
              } catch (error) {
                stack = error.stack;
              }
              if (stack.indexOf('_wrapObject') === -1) {
                console && console.warn && console.warn('iterable.length has been deprecated, ' + 'use iterable.size or iterable.count(). ' + 'This warning will become a silent error in a future version. ' + stack);
                return this.size;
              }
            }
          }});
      } catch (e) {}
    })();
    mixin(KeyedIterable, {
      flip: function() {
        return reify(this, flipFactory(this));
      },
      findKey: function(predicate, context) {
        var entry = this.findEntry(predicate, context);
        return entry && entry[0];
      },
      findLastKey: function(predicate, context) {
        return this.toSeq().reverse().findKey(predicate, context);
      },
      keyOf: function(searchValue) {
        return this.findKey(function(value) {
          return is(value, searchValue);
        });
      },
      lastKeyOf: function(searchValue) {
        return this.findLastKey(function(value) {
          return is(value, searchValue);
        });
      },
      mapEntries: function(mapper, context) {
        var this$0 = this;
        var iterations = 0;
        return reify(this, this.toSeq().map(function(v, k) {
          return mapper.call(context, [k, v], iterations++, this$0);
        }).fromEntrySeq());
      },
      mapKeys: function(mapper, context) {
        var this$0 = this;
        return reify(this, this.toSeq().flip().map(function(k, v) {
          return mapper.call(context, k, v, this$0);
        }).flip());
      }
    });
    var KeyedIterablePrototype = KeyedIterable.prototype;
    KeyedIterablePrototype[IS_KEYED_SENTINEL] = true;
    KeyedIterablePrototype[ITERATOR_SYMBOL] = IterablePrototype.entries;
    KeyedIterablePrototype.__toJS = IterablePrototype.toObject;
    KeyedIterablePrototype.__toStringMapper = function(v, k) {
      return JSON.stringify(k) + ': ' + quoteString(v);
    };
    mixin(IndexedIterable, {
      toKeyedSeq: function() {
        return new ToKeyedSequence(this, false);
      },
      filter: function(predicate, context) {
        return reify(this, filterFactory(this, predicate, context, false));
      },
      findIndex: function(predicate, context) {
        var entry = this.findEntry(predicate, context);
        return entry ? entry[0] : -1;
      },
      indexOf: function(searchValue) {
        var key = this.toKeyedSeq().keyOf(searchValue);
        return key === undefined ? -1 : key;
      },
      lastIndexOf: function(searchValue) {
        return this.toSeq().reverse().indexOf(searchValue);
      },
      reverse: function() {
        return reify(this, reverseFactory(this, false));
      },
      slice: function(begin, end) {
        return reify(this, sliceFactory(this, begin, end, false));
      },
      splice: function(index, removeNum) {
        var numArgs = arguments.length;
        removeNum = Math.max(removeNum | 0, 0);
        if (numArgs === 0 || (numArgs === 2 && !removeNum)) {
          return this;
        }
        index = resolveBegin(index, this.size);
        var spliced = this.slice(0, index);
        return reify(this, numArgs === 1 ? spliced : spliced.concat(arrCopy(arguments, 2), this.slice(index + removeNum)));
      },
      findLastIndex: function(predicate, context) {
        var key = this.toKeyedSeq().findLastKey(predicate, context);
        return key === undefined ? -1 : key;
      },
      first: function() {
        return this.get(0);
      },
      flatten: function(depth) {
        return reify(this, flattenFactory(this, depth, false));
      },
      get: function(index, notSetValue) {
        index = wrapIndex(this, index);
        return (index < 0 || (this.size === Infinity || (this.size !== undefined && index > this.size))) ? notSetValue : this.find(function(_, key) {
          return key === index;
        }, undefined, notSetValue);
      },
      has: function(index) {
        index = wrapIndex(this, index);
        return index >= 0 && (this.size !== undefined ? this.size === Infinity || index < this.size : this.indexOf(index) !== -1);
      },
      interpose: function(separator) {
        return reify(this, interposeFactory(this, separator));
      },
      interleave: function() {
        var iterables = [this].concat(arrCopy(arguments));
        var zipped = zipWithFactory(this.toSeq(), IndexedSeq.of, iterables);
        var interleaved = zipped.flatten(true);
        if (zipped.size) {
          interleaved.size = zipped.size * iterables.length;
        }
        return reify(this, interleaved);
      },
      last: function() {
        return this.get(-1);
      },
      skipWhile: function(predicate, context) {
        return reify(this, skipWhileFactory(this, predicate, context, false));
      },
      zip: function() {
        var iterables = [this].concat(arrCopy(arguments));
        return reify(this, zipWithFactory(this, defaultZipper, iterables));
      },
      zipWith: function(zipper) {
        var iterables = arrCopy(arguments);
        iterables[0] = this;
        return reify(this, zipWithFactory(this, zipper, iterables));
      }
    });
    IndexedIterable.prototype[IS_INDEXED_SENTINEL] = true;
    IndexedIterable.prototype[IS_ORDERED_SENTINEL] = true;
    mixin(SetIterable, {
      get: function(value, notSetValue) {
        return this.has(value) ? value : notSetValue;
      },
      includes: function(value) {
        return this.has(value);
      },
      keySeq: function() {
        return this.valueSeq();
      }
    });
    SetIterable.prototype.has = IterablePrototype.includes;
    mixin(KeyedSeq, KeyedIterable.prototype);
    mixin(IndexedSeq, IndexedIterable.prototype);
    mixin(SetSeq, SetIterable.prototype);
    mixin(KeyedCollection, KeyedIterable.prototype);
    mixin(IndexedCollection, IndexedIterable.prototype);
    mixin(SetCollection, SetIterable.prototype);
    function keyMapper(v, k) {
      return k;
    }
    function entryMapper(v, k) {
      return [k, v];
    }
    function not(predicate) {
      return function() {
        return !predicate.apply(this, arguments);
      };
    }
    function neg(predicate) {
      return function() {
        return -predicate.apply(this, arguments);
      };
    }
    function quoteString(value) {
      return typeof value === 'string' ? JSON.stringify(value) : value;
    }
    function defaultZipper() {
      return arrCopy(arguments);
    }
    function defaultNegComparator(a, b) {
      return a < b ? 1 : a > b ? -1 : 0;
    }
    function hashIterable(iterable) {
      if (iterable.size === Infinity) {
        return 0;
      }
      var ordered = isOrdered(iterable);
      var keyed = isKeyed(iterable);
      var h = ordered ? 1 : 0;
      var size = iterable.__iterate(keyed ? ordered ? function(v, k) {
        h = 31 * h + hashMerge(hash(v), hash(k)) | 0;
      } : function(v, k) {
        h = h + hashMerge(hash(v), hash(k)) | 0;
      } : ordered ? function(v) {
        h = 31 * h + hash(v) | 0;
      } : function(v) {
        h = h + hash(v) | 0;
      });
      return murmurHashOfSize(size, h);
    }
    function murmurHashOfSize(size, h) {
      h = src_Math__imul(h, 0xCC9E2D51);
      h = src_Math__imul(h << 15 | h >>> -15, 0x1B873593);
      h = src_Math__imul(h << 13 | h >>> -13, 5);
      h = (h + 0xE6546B64 | 0) ^ size;
      h = src_Math__imul(h ^ h >>> 16, 0x85EBCA6B);
      h = src_Math__imul(h ^ h >>> 13, 0xC2B2AE35);
      h = smi(h ^ h >>> 16);
      return h;
    }
    function hashMerge(a, b) {
      return a ^ b + 0x9E3779B9 + (a << 6) + (a >> 2) | 0;
    }
    var Immutable = {
      Iterable: Iterable,
      Seq: Seq,
      Collection: Collection,
      Map: src_Map__Map,
      OrderedMap: OrderedMap,
      List: List,
      Stack: Stack,
      Set: src_Set__Set,
      OrderedSet: OrderedSet,
      Record: Record,
      Range: Range,
      Repeat: Repeat,
      is: is,
      fromJS: fromJS
    };
    return Immutable;
  }));
  global.define = __define;
  return module.exports;
});



System.register("npm:flux@2.0.3/lib/invariant", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var invariant = function(condition, format, a, b, c, d, e, f) {
    if (false) {
      if (format === undefined) {
        throw new Error('invariant requires an error message argument');
      }
    }
    if (!condition) {
      var error;
      if (format === undefined) {
        error = new Error('Minified exception occurred; use the non-minified dev environment ' + 'for the full error message and additional helpful warnings.');
      } else {
        var args = [a, b, c, d, e, f];
        var argIndex = 0;
        error = new Error('Invariant Violation: ' + format.replace(/%s/g, function() {
          return args[argIndex++];
        }));
      }
      error.framesToPop = 1;
      throw error;
    }
  };
  module.exports = invariant;
  global.define = __define;
  return module.exports;
});



System.register("~/bootstrap.jsx!github:floatdrop/plugin-jsx@1.1.0", ["npm:react@0.13.3"], function (_export) {
  var React;

  _export("default", bootstrap);

  function bootstrap() {
    var CommentBox = React.createClass({ displayName: "CommentBox",
      render: function render() {
        return React.createElement("div", { "class": "commentBox" }, "Hello, world! I am a CommentBox");
      }
    });
    React.render(React.createElement(CommentBox, null), document.getElementById("content"));
  }

  return {
    setters: [function (_npmReact0133) {
      React = _npmReact0133["default"];
    }],
    execute: function () {
      "use strict";
    }
  };
});
System.register("npm:lodash@3.9.1/internal/getLength", ["npm:lodash@3.9.1/internal/baseProperty"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseProperty = require("npm:lodash@3.9.1/internal/baseProperty");
  var getLength = baseProperty('length');
  module.exports = getLength;
  global.define = __define;
  return module.exports;
});



System.register("npm:process@0.10.1", ["npm:process@0.10.1/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:process@0.10.1/browser");
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/toObject", ["npm:lodash@3.9.1/lang/isObject", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var isObject = require("npm:lodash@3.9.1/lang/isObject");
    function toObject(value) {
      return isObject(value) ? value : Object(value);
    }
    module.exports = toObject;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/object/keysIn", ["npm:lodash@3.9.1/lang/isArguments", "npm:lodash@3.9.1/lang/isArray", "npm:lodash@3.9.1/internal/isIndex", "npm:lodash@3.9.1/internal/isLength", "npm:lodash@3.9.1/lang/isObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isArguments = require("npm:lodash@3.9.1/lang/isArguments"),
      isArray = require("npm:lodash@3.9.1/lang/isArray"),
      isIndex = require("npm:lodash@3.9.1/internal/isIndex"),
      isLength = require("npm:lodash@3.9.1/internal/isLength"),
      isObject = require("npm:lodash@3.9.1/lang/isObject");
  var objectProto = Object.prototype;
  var hasOwnProperty = objectProto.hasOwnProperty;
  function keysIn(object) {
    if (object == null) {
      return [];
    }
    if (!isObject(object)) {
      object = Object(object);
    }
    var length = object.length;
    length = (length && isLength(length) && (isArray(object) || isArguments(object)) && length) || 0;
    var Ctor = object.constructor,
        index = -1,
        isProto = typeof Ctor == 'function' && Ctor.prototype === object,
        result = Array(length),
        skipIndexes = length > 0;
    while (++index < length) {
      result[index] = (index + '');
    }
    for (var key in object) {
      if (!(skipIndexes && isIndex(key, length)) && !(key == 'constructor' && (isProto || !hasOwnProperty.call(object, key)))) {
        result.push(key);
      }
    }
    return result;
  }
  module.exports = keysIn;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/lang/toPlainObject", ["npm:lodash@3.9.1/internal/baseCopy", "npm:lodash@3.9.1/object/keysIn"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseCopy = require("npm:lodash@3.9.1/internal/baseCopy"),
      keysIn = require("npm:lodash@3.9.1/object/keysIn");
  function toPlainObject(value) {
    return baseCopy(value, keysIn(value));
  }
  module.exports = toPlainObject;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/object/keys", ["npm:lodash@3.9.1/internal/getNative", "npm:lodash@3.9.1/internal/isArrayLike", "npm:lodash@3.9.1/lang/isObject", "npm:lodash@3.9.1/internal/shimKeys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var getNative = require("npm:lodash@3.9.1/internal/getNative"),
      isArrayLike = require("npm:lodash@3.9.1/internal/isArrayLike"),
      isObject = require("npm:lodash@3.9.1/lang/isObject"),
      shimKeys = require("npm:lodash@3.9.1/internal/shimKeys");
  var nativeKeys = getNative(Object, 'keys');
  var keys = !nativeKeys ? shimKeys : function(object) {
    var Ctor = object == null ? null : object.constructor;
    if ((typeof Ctor == 'function' && Ctor.prototype === object) || (typeof object != 'function' && isArrayLike(object))) {
      return shimKeys(object);
    }
    return isObject(object) ? nativeKeys(object) : [];
  };
  module.exports = keys;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/bindCallback", ["npm:lodash@3.9.1/utility/identity"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var identity = require("npm:lodash@3.9.1/utility/identity");
  function bindCallback(func, thisArg, argCount) {
    if (typeof func != 'function') {
      return identity;
    }
    if (thisArg === undefined) {
      return func;
    }
    switch (argCount) {
      case 1:
        return function(value) {
          return func.call(thisArg, value);
        };
      case 3:
        return function(value, index, collection) {
          return func.call(thisArg, value, index, collection);
        };
      case 4:
        return function(accumulator, value, index, collection) {
          return func.call(thisArg, accumulator, value, index, collection);
        };
      case 5:
        return function(value, other, key, object, source) {
          return func.call(thisArg, value, other, key, object, source);
        };
    }
    return function() {
      return func.apply(thisArg, arguments);
    };
  }
  module.exports = bindCallback;
  global.define = __define;
  return module.exports;
});



System.register("npm:radium@0.10.3/modules/mixins/browser-state", ["npm:radium@0.10.3/modules/mixins/util/mouse-up-listener"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var mouseUpListener = require("npm:radium@0.10.3/modules/mixins/util/mouse-up-listener");
  var BrowserStateMixin = {
    componentDidMount: function() {
      this.mouseUpListener = mouseUpListener.subscribe(this.radiumMouseUp);
    },
    componentWillUnmount: function() {
      this.mouseUpListener.remove();
    },
    getInitialState: function() {
      return {
        hover: false,
        focus: false,
        active: false
      };
    },
    getBrowserStateEvents: function() {
      return {
        onMouseEnter: this.radiumMouseEnter,
        onMouseLeave: this.radiumMouseLeave,
        onMouseDown: this.radiumMouseDown,
        onFocus: this.radiumFocus,
        onBlur: this.radiumBlur
      };
    },
    _callRadiumHandler: function(handler, ev) {
      var currentHandler = this.props[handler];
      if (currentHandler) {
        currentHandler(ev);
      }
    },
    radiumMouseEnter: function(ev) {
      this._callRadiumHandler('onMouseEnter', ev);
      this.setState({hover: true});
    },
    radiumMouseLeave: function(ev) {
      this._callRadiumHandler('onMouseLeave', ev);
      this.setState({hover: false});
    },
    radiumMouseDown: function(ev) {
      this._callRadiumHandler('onMouseDown', ev);
      this.setState({active: true});
    },
    radiumMouseUp: function() {
      if (this.state.active) {
        this.setState({active: false});
      }
    },
    radiumFocus: function(ev) {
      this._callRadiumHandler('onFocus', ev);
      this.setState({focus: true});
    },
    radiumBlur: function(ev) {
      this._callRadiumHandler('onBlur', ev);
      this.setState({focus: false});
    }
  };
  module.exports = BrowserStateMixin;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/keyMirror", ["npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var keyMirror = function(obj) {
      var ret = {};
      var key;
      ("production" !== process.env.NODE_ENV ? invariant(obj instanceof Object && !Array.isArray(obj), 'keyMirror(...): Argument must be an object.') : invariant(obj instanceof Object && !Array.isArray(obj)));
      for (key in obj) {
        if (!obj.hasOwnProperty(key)) {
          continue;
        }
        ret[key] = key;
      }
      return ret;
    };
    module.exports = keyMirror;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/warning", ["npm:react@0.13.3/lib/emptyFunction", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    "use strict";
    var emptyFunction = require("npm:react@0.13.3/lib/emptyFunction");
    var warning = emptyFunction;
    if ("production" !== process.env.NODE_ENV) {
      warning = function(condition, format) {
        for (var args = [],
            $__0 = 2,
            $__1 = arguments.length; $__0 < $__1; $__0++)
          args.push(arguments[$__0]);
        if (format === undefined) {
          throw new Error('`warning(condition, format, ...args)` requires a warning ' + 'message argument');
        }
        if (format.length < 10 || /^[s\W]*$/.test(format)) {
          throw new Error('The warning format should be able to uniquely identify this ' + 'warning. Please, use a more descriptive format than: ' + format);
        }
        if (format.indexOf('Failed Composite propType: ') === 0) {
          return ;
        }
        if (!condition) {
          var argIndex = 0;
          var message = 'Warning: ' + format.replace(/%s/g, function() {
            return args[argIndex++];
          });
          console.warn(message);
          try {
            throw new Error(message);
          } catch (x) {}
        }
      };
    }
    module.exports = warning;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactInstanceHandles", ["npm:react@0.13.3/lib/ReactRootIndex", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactRootIndex = require("npm:react@0.13.3/lib/ReactRootIndex");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var SEPARATOR = '.';
    var SEPARATOR_LENGTH = SEPARATOR.length;
    var MAX_TREE_DEPTH = 100;
    function getReactRootIDString(index) {
      return SEPARATOR + index.toString(36);
    }
    function isBoundary(id, index) {
      return id.charAt(index) === SEPARATOR || index === id.length;
    }
    function isValidID(id) {
      return id === '' || (id.charAt(0) === SEPARATOR && id.charAt(id.length - 1) !== SEPARATOR);
    }
    function isAncestorIDOf(ancestorID, descendantID) {
      return (descendantID.indexOf(ancestorID) === 0 && isBoundary(descendantID, ancestorID.length));
    }
    function getParentID(id) {
      return id ? id.substr(0, id.lastIndexOf(SEPARATOR)) : '';
    }
    function getNextDescendantID(ancestorID, destinationID) {
      ("production" !== process.env.NODE_ENV ? invariant(isValidID(ancestorID) && isValidID(destinationID), 'getNextDescendantID(%s, %s): Received an invalid React DOM ID.', ancestorID, destinationID) : invariant(isValidID(ancestorID) && isValidID(destinationID)));
      ("production" !== process.env.NODE_ENV ? invariant(isAncestorIDOf(ancestorID, destinationID), 'getNextDescendantID(...): React has made an invalid assumption about ' + 'the DOM hierarchy. Expected `%s` to be an ancestor of `%s`.', ancestorID, destinationID) : invariant(isAncestorIDOf(ancestorID, destinationID)));
      if (ancestorID === destinationID) {
        return ancestorID;
      }
      var start = ancestorID.length + SEPARATOR_LENGTH;
      var i;
      for (i = start; i < destinationID.length; i++) {
        if (isBoundary(destinationID, i)) {
          break;
        }
      }
      return destinationID.substr(0, i);
    }
    function getFirstCommonAncestorID(oneID, twoID) {
      var minLength = Math.min(oneID.length, twoID.length);
      if (minLength === 0) {
        return '';
      }
      var lastCommonMarkerIndex = 0;
      for (var i = 0; i <= minLength; i++) {
        if (isBoundary(oneID, i) && isBoundary(twoID, i)) {
          lastCommonMarkerIndex = i;
        } else if (oneID.charAt(i) !== twoID.charAt(i)) {
          break;
        }
      }
      var longestCommonID = oneID.substr(0, lastCommonMarkerIndex);
      ("production" !== process.env.NODE_ENV ? invariant(isValidID(longestCommonID), 'getFirstCommonAncestorID(%s, %s): Expected a valid React DOM ID: %s', oneID, twoID, longestCommonID) : invariant(isValidID(longestCommonID)));
      return longestCommonID;
    }
    function traverseParentPath(start, stop, cb, arg, skipFirst, skipLast) {
      start = start || '';
      stop = stop || '';
      ("production" !== process.env.NODE_ENV ? invariant(start !== stop, 'traverseParentPath(...): Cannot traverse from and to the same ID, `%s`.', start) : invariant(start !== stop));
      var traverseUp = isAncestorIDOf(stop, start);
      ("production" !== process.env.NODE_ENV ? invariant(traverseUp || isAncestorIDOf(start, stop), 'traverseParentPath(%s, %s, ...): Cannot traverse from two IDs that do ' + 'not have a parent path.', start, stop) : invariant(traverseUp || isAncestorIDOf(start, stop)));
      var depth = 0;
      var traverse = traverseUp ? getParentID : getNextDescendantID;
      for (var id = start; ; id = traverse(id, stop)) {
        var ret;
        if ((!skipFirst || id !== start) && (!skipLast || id !== stop)) {
          ret = cb(id, traverseUp, arg);
        }
        if (ret === false || id === stop) {
          break;
        }
        ("production" !== process.env.NODE_ENV ? invariant(depth++ < MAX_TREE_DEPTH, 'traverseParentPath(%s, %s, ...): Detected an infinite loop while ' + 'traversing the React DOM ID tree. This may be due to malformed IDs: %s', start, stop) : invariant(depth++ < MAX_TREE_DEPTH));
      }
    }
    var ReactInstanceHandles = {
      createReactRootID: function() {
        return getReactRootIDString(ReactRootIndex.createReactRootIndex());
      },
      createReactID: function(rootID, name) {
        return rootID + name;
      },
      getReactRootIDFromNodeID: function(id) {
        if (id && id.charAt(0) === SEPARATOR && id.length > 1) {
          var index = id.indexOf(SEPARATOR, 1);
          return index > -1 ? id.substr(0, index) : id;
        }
        return null;
      },
      traverseEnterLeave: function(leaveID, enterID, cb, upArg, downArg) {
        var ancestorID = getFirstCommonAncestorID(leaveID, enterID);
        if (ancestorID !== leaveID) {
          traverseParentPath(leaveID, ancestorID, cb, upArg, false, true);
        }
        if (ancestorID !== enterID) {
          traverseParentPath(ancestorID, enterID, cb, downArg, true, false);
        }
      },
      traverseTwoPhase: function(targetID, cb, arg) {
        if (targetID) {
          traverseParentPath('', targetID, cb, arg, true, false);
          traverseParentPath(targetID, '', cb, arg, false, true);
        }
      },
      traverseAncestors: function(targetID, cb, arg) {
        traverseParentPath('', targetID, cb, arg, true, false);
      },
      _getFirstCommonAncestorID: getFirstCommonAncestorID,
      _getNextDescendantID: getNextDescendantID,
      isAncestorIDOf: isAncestorIDOf,
      SEPARATOR: SEPARATOR
    };
    module.exports = ReactInstanceHandles;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactRef", ["npm:react@0.13.3/lib/ReactOwner", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactOwner = require("npm:react@0.13.3/lib/ReactOwner");
    var ReactRef = {};
    function attachRef(ref, component, owner) {
      if (typeof ref === 'function') {
        ref(component.getPublicInstance());
      } else {
        ReactOwner.addComponentAsRefTo(component, ref, owner);
      }
    }
    function detachRef(ref, component, owner) {
      if (typeof ref === 'function') {
        ref(null);
      } else {
        ReactOwner.removeComponentAsRefFrom(component, ref, owner);
      }
    }
    ReactRef.attachRefs = function(instance, element) {
      var ref = element.ref;
      if (ref != null) {
        attachRef(ref, instance, element._owner);
      }
    };
    ReactRef.shouldUpdateRefs = function(prevElement, nextElement) {
      return (nextElement._owner !== prevElement._owner || nextElement.ref !== prevElement.ref);
    };
    ReactRef.detachRefs = function(instance, element) {
      var ref = element.ref;
      if (ref != null) {
        detachRef(ref, instance, element._owner);
      }
    };
    module.exports = ReactRef;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactElementValidator", ["npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactFragment", "npm:react@0.13.3/lib/ReactPropTypeLocations", "npm:react@0.13.3/lib/ReactPropTypeLocationNames", "npm:react@0.13.3/lib/ReactCurrentOwner", "npm:react@0.13.3/lib/ReactNativeComponent", "npm:react@0.13.3/lib/getIteratorFn", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactFragment = require("npm:react@0.13.3/lib/ReactFragment");
    var ReactPropTypeLocations = require("npm:react@0.13.3/lib/ReactPropTypeLocations");
    var ReactPropTypeLocationNames = require("npm:react@0.13.3/lib/ReactPropTypeLocationNames");
    var ReactCurrentOwner = require("npm:react@0.13.3/lib/ReactCurrentOwner");
    var ReactNativeComponent = require("npm:react@0.13.3/lib/ReactNativeComponent");
    var getIteratorFn = require("npm:react@0.13.3/lib/getIteratorFn");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var warning = require("npm:react@0.13.3/lib/warning");
    function getDeclarationErrorAddendum() {
      if (ReactCurrentOwner.current) {
        var name = ReactCurrentOwner.current.getName();
        if (name) {
          return ' Check the render method of `' + name + '`.';
        }
      }
      return '';
    }
    var ownerHasKeyUseWarning = {};
    var loggedTypeFailures = {};
    var NUMERIC_PROPERTY_REGEX = /^\d+$/;
    function getName(instance) {
      var publicInstance = instance && instance.getPublicInstance();
      if (!publicInstance) {
        return undefined;
      }
      var constructor = publicInstance.constructor;
      if (!constructor) {
        return undefined;
      }
      return constructor.displayName || constructor.name || undefined;
    }
    function getCurrentOwnerDisplayName() {
      var current = ReactCurrentOwner.current;
      return (current && getName(current) || undefined);
    }
    function validateExplicitKey(element, parentType) {
      if (element._store.validated || element.key != null) {
        return ;
      }
      element._store.validated = true;
      warnAndMonitorForKeyUse('Each child in an array or iterator should have a unique "key" prop.', element, parentType);
    }
    function validatePropertyKey(name, element, parentType) {
      if (!NUMERIC_PROPERTY_REGEX.test(name)) {
        return ;
      }
      warnAndMonitorForKeyUse('Child objects should have non-numeric keys so ordering is preserved.', element, parentType);
    }
    function warnAndMonitorForKeyUse(message, element, parentType) {
      var ownerName = getCurrentOwnerDisplayName();
      var parentName = typeof parentType === 'string' ? parentType : parentType.displayName || parentType.name;
      var useName = ownerName || parentName;
      var memoizer = ownerHasKeyUseWarning[message] || ((ownerHasKeyUseWarning[message] = {}));
      if (memoizer.hasOwnProperty(useName)) {
        return ;
      }
      memoizer[useName] = true;
      var parentOrOwnerAddendum = ownerName ? (" Check the render method of " + ownerName + ".") : parentName ? (" Check the React.render call using <" + parentName + ">.") : '';
      var childOwnerAddendum = '';
      if (element && element._owner && element._owner !== ReactCurrentOwner.current) {
        var childOwnerName = getName(element._owner);
        childOwnerAddendum = (" It was passed a child from " + childOwnerName + ".");
      }
      ("production" !== process.env.NODE_ENV ? warning(false, message + '%s%s See https://fb.me/react-warning-keys for more information.', parentOrOwnerAddendum, childOwnerAddendum) : null);
    }
    function validateChildKeys(node, parentType) {
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
          var child = node[i];
          if (ReactElement.isValidElement(child)) {
            validateExplicitKey(child, parentType);
          }
        }
      } else if (ReactElement.isValidElement(node)) {
        node._store.validated = true;
      } else if (node) {
        var iteratorFn = getIteratorFn(node);
        if (iteratorFn) {
          if (iteratorFn !== node.entries) {
            var iterator = iteratorFn.call(node);
            var step;
            while (!(step = iterator.next()).done) {
              if (ReactElement.isValidElement(step.value)) {
                validateExplicitKey(step.value, parentType);
              }
            }
          }
        } else if (typeof node === 'object') {
          var fragment = ReactFragment.extractIfFragment(node);
          for (var key in fragment) {
            if (fragment.hasOwnProperty(key)) {
              validatePropertyKey(key, fragment[key], parentType);
            }
          }
        }
      }
    }
    function checkPropTypes(componentName, propTypes, props, location) {
      for (var propName in propTypes) {
        if (propTypes.hasOwnProperty(propName)) {
          var error;
          try {
            ("production" !== process.env.NODE_ENV ? invariant(typeof propTypes[propName] === 'function', '%s: %s type `%s` is invalid; it must be a function, usually from ' + 'React.PropTypes.', componentName || 'React class', ReactPropTypeLocationNames[location], propName) : invariant(typeof propTypes[propName] === 'function'));
            error = propTypes[propName](props, propName, componentName, location);
          } catch (ex) {
            error = ex;
          }
          if (error instanceof Error && !(error.message in loggedTypeFailures)) {
            loggedTypeFailures[error.message] = true;
            var addendum = getDeclarationErrorAddendum(this);
            ("production" !== process.env.NODE_ENV ? warning(false, 'Failed propType: %s%s', error.message, addendum) : null);
          }
        }
      }
    }
    var warnedPropsMutations = {};
    function warnForPropsMutation(propName, element) {
      var type = element.type;
      var elementName = typeof type === 'string' ? type : type.displayName;
      var ownerName = element._owner ? element._owner.getPublicInstance().constructor.displayName : null;
      var warningKey = propName + '|' + elementName + '|' + ownerName;
      if (warnedPropsMutations.hasOwnProperty(warningKey)) {
        return ;
      }
      warnedPropsMutations[warningKey] = true;
      var elementInfo = '';
      if (elementName) {
        elementInfo = ' <' + elementName + ' />';
      }
      var ownerInfo = '';
      if (ownerName) {
        ownerInfo = ' The element was created by ' + ownerName + '.';
      }
      ("production" !== process.env.NODE_ENV ? warning(false, 'Don\'t set .props.%s of the React component%s. Instead, specify the ' + 'correct value when initially creating the element or use ' + 'React.cloneElement to make a new element with updated props.%s', propName, elementInfo, ownerInfo) : null);
    }
    function is(a, b) {
      if (a !== a) {
        return b !== b;
      }
      if (a === 0 && b === 0) {
        return 1 / a === 1 / b;
      }
      return a === b;
    }
    function checkAndWarnForMutatedProps(element) {
      if (!element._store) {
        return ;
      }
      var originalProps = element._store.originalProps;
      var props = element.props;
      for (var propName in props) {
        if (props.hasOwnProperty(propName)) {
          if (!originalProps.hasOwnProperty(propName) || !is(originalProps[propName], props[propName])) {
            warnForPropsMutation(propName, element);
            originalProps[propName] = props[propName];
          }
        }
      }
    }
    function validatePropTypes(element) {
      if (element.type == null) {
        return ;
      }
      var componentClass = ReactNativeComponent.getComponentClassForElement(element);
      var name = componentClass.displayName || componentClass.name;
      if (componentClass.propTypes) {
        checkPropTypes(name, componentClass.propTypes, element.props, ReactPropTypeLocations.prop);
      }
      if (typeof componentClass.getDefaultProps === 'function') {
        ("production" !== process.env.NODE_ENV ? warning(componentClass.getDefaultProps.isReactClassApproved, 'getDefaultProps is only used on classic React.createClass ' + 'definitions. Use a static property named `defaultProps` instead.') : null);
      }
    }
    var ReactElementValidator = {
      checkAndWarnForMutatedProps: checkAndWarnForMutatedProps,
      createElement: function(type, props, children) {
        ("production" !== process.env.NODE_ENV ? warning(type != null, 'React.createElement: type should not be null or undefined. It should ' + 'be a string (for DOM elements) or a ReactClass (for composite ' + 'components).') : null);
        var element = ReactElement.createElement.apply(this, arguments);
        if (element == null) {
          return element;
        }
        for (var i = 2; i < arguments.length; i++) {
          validateChildKeys(arguments[i], type);
        }
        validatePropTypes(element);
        return element;
      },
      createFactory: function(type) {
        var validatedFactory = ReactElementValidator.createElement.bind(null, type);
        validatedFactory.type = type;
        if ("production" !== process.env.NODE_ENV) {
          try {
            Object.defineProperty(validatedFactory, 'type', {
              enumerable: false,
              get: function() {
                ("production" !== process.env.NODE_ENV ? warning(false, 'Factory.type is deprecated. Access the class directly ' + 'before passing it to createFactory.') : null);
                Object.defineProperty(this, 'type', {value: type});
                return type;
              }
            });
          } catch (x) {}
        }
        return validatedFactory;
      },
      cloneElement: function(element, props, children) {
        var newElement = ReactElement.cloneElement.apply(this, arguments);
        for (var i = 2; i < arguments.length; i++) {
          validateChildKeys(arguments[i], newElement.type);
        }
        validatePropTypes(newElement);
        return newElement;
      }
    };
    module.exports = ReactElementValidator;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactClass", ["npm:react@0.13.3/lib/ReactComponent", "npm:react@0.13.3/lib/ReactCurrentOwner", "npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactErrorUtils", "npm:react@0.13.3/lib/ReactInstanceMap", "npm:react@0.13.3/lib/ReactLifeCycle", "npm:react@0.13.3/lib/ReactPropTypeLocations", "npm:react@0.13.3/lib/ReactPropTypeLocationNames", "npm:react@0.13.3/lib/ReactUpdateQueue", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/keyMirror", "npm:react@0.13.3/lib/keyOf", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactComponent = require("npm:react@0.13.3/lib/ReactComponent");
    var ReactCurrentOwner = require("npm:react@0.13.3/lib/ReactCurrentOwner");
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactErrorUtils = require("npm:react@0.13.3/lib/ReactErrorUtils");
    var ReactInstanceMap = require("npm:react@0.13.3/lib/ReactInstanceMap");
    var ReactLifeCycle = require("npm:react@0.13.3/lib/ReactLifeCycle");
    var ReactPropTypeLocations = require("npm:react@0.13.3/lib/ReactPropTypeLocations");
    var ReactPropTypeLocationNames = require("npm:react@0.13.3/lib/ReactPropTypeLocationNames");
    var ReactUpdateQueue = require("npm:react@0.13.3/lib/ReactUpdateQueue");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var keyMirror = require("npm:react@0.13.3/lib/keyMirror");
    var keyOf = require("npm:react@0.13.3/lib/keyOf");
    var warning = require("npm:react@0.13.3/lib/warning");
    var MIXINS_KEY = keyOf({mixins: null});
    var SpecPolicy = keyMirror({
      DEFINE_ONCE: null,
      DEFINE_MANY: null,
      OVERRIDE_BASE: null,
      DEFINE_MANY_MERGED: null
    });
    var injectedMixins = [];
    var ReactClassInterface = {
      mixins: SpecPolicy.DEFINE_MANY,
      statics: SpecPolicy.DEFINE_MANY,
      propTypes: SpecPolicy.DEFINE_MANY,
      contextTypes: SpecPolicy.DEFINE_MANY,
      childContextTypes: SpecPolicy.DEFINE_MANY,
      getDefaultProps: SpecPolicy.DEFINE_MANY_MERGED,
      getInitialState: SpecPolicy.DEFINE_MANY_MERGED,
      getChildContext: SpecPolicy.DEFINE_MANY_MERGED,
      render: SpecPolicy.DEFINE_ONCE,
      componentWillMount: SpecPolicy.DEFINE_MANY,
      componentDidMount: SpecPolicy.DEFINE_MANY,
      componentWillReceiveProps: SpecPolicy.DEFINE_MANY,
      shouldComponentUpdate: SpecPolicy.DEFINE_ONCE,
      componentWillUpdate: SpecPolicy.DEFINE_MANY,
      componentDidUpdate: SpecPolicy.DEFINE_MANY,
      componentWillUnmount: SpecPolicy.DEFINE_MANY,
      updateComponent: SpecPolicy.OVERRIDE_BASE
    };
    var RESERVED_SPEC_KEYS = {
      displayName: function(Constructor, displayName) {
        Constructor.displayName = displayName;
      },
      mixins: function(Constructor, mixins) {
        if (mixins) {
          for (var i = 0; i < mixins.length; i++) {
            mixSpecIntoComponent(Constructor, mixins[i]);
          }
        }
      },
      childContextTypes: function(Constructor, childContextTypes) {
        if ("production" !== process.env.NODE_ENV) {
          validateTypeDef(Constructor, childContextTypes, ReactPropTypeLocations.childContext);
        }
        Constructor.childContextTypes = assign({}, Constructor.childContextTypes, childContextTypes);
      },
      contextTypes: function(Constructor, contextTypes) {
        if ("production" !== process.env.NODE_ENV) {
          validateTypeDef(Constructor, contextTypes, ReactPropTypeLocations.context);
        }
        Constructor.contextTypes = assign({}, Constructor.contextTypes, contextTypes);
      },
      getDefaultProps: function(Constructor, getDefaultProps) {
        if (Constructor.getDefaultProps) {
          Constructor.getDefaultProps = createMergedResultFunction(Constructor.getDefaultProps, getDefaultProps);
        } else {
          Constructor.getDefaultProps = getDefaultProps;
        }
      },
      propTypes: function(Constructor, propTypes) {
        if ("production" !== process.env.NODE_ENV) {
          validateTypeDef(Constructor, propTypes, ReactPropTypeLocations.prop);
        }
        Constructor.propTypes = assign({}, Constructor.propTypes, propTypes);
      },
      statics: function(Constructor, statics) {
        mixStaticSpecIntoComponent(Constructor, statics);
      }
    };
    function validateTypeDef(Constructor, typeDef, location) {
      for (var propName in typeDef) {
        if (typeDef.hasOwnProperty(propName)) {
          ("production" !== process.env.NODE_ENV ? warning(typeof typeDef[propName] === 'function', '%s: %s type `%s` is invalid; it must be a function, usually from ' + 'React.PropTypes.', Constructor.displayName || 'ReactClass', ReactPropTypeLocationNames[location], propName) : null);
        }
      }
    }
    function validateMethodOverride(proto, name) {
      var specPolicy = ReactClassInterface.hasOwnProperty(name) ? ReactClassInterface[name] : null;
      if (ReactClassMixin.hasOwnProperty(name)) {
        ("production" !== process.env.NODE_ENV ? invariant(specPolicy === SpecPolicy.OVERRIDE_BASE, 'ReactClassInterface: You are attempting to override ' + '`%s` from your class specification. Ensure that your method names ' + 'do not overlap with React methods.', name) : invariant(specPolicy === SpecPolicy.OVERRIDE_BASE));
      }
      if (proto.hasOwnProperty(name)) {
        ("production" !== process.env.NODE_ENV ? invariant(specPolicy === SpecPolicy.DEFINE_MANY || specPolicy === SpecPolicy.DEFINE_MANY_MERGED, 'ReactClassInterface: You are attempting to define ' + '`%s` on your component more than once. This conflict may be due ' + 'to a mixin.', name) : invariant(specPolicy === SpecPolicy.DEFINE_MANY || specPolicy === SpecPolicy.DEFINE_MANY_MERGED));
      }
    }
    function mixSpecIntoComponent(Constructor, spec) {
      if (!spec) {
        return ;
      }
      ("production" !== process.env.NODE_ENV ? invariant(typeof spec !== 'function', 'ReactClass: You\'re attempting to ' + 'use a component class as a mixin. Instead, just use a regular object.') : invariant(typeof spec !== 'function'));
      ("production" !== process.env.NODE_ENV ? invariant(!ReactElement.isValidElement(spec), 'ReactClass: You\'re attempting to ' + 'use a component as a mixin. Instead, just use a regular object.') : invariant(!ReactElement.isValidElement(spec)));
      var proto = Constructor.prototype;
      if (spec.hasOwnProperty(MIXINS_KEY)) {
        RESERVED_SPEC_KEYS.mixins(Constructor, spec.mixins);
      }
      for (var name in spec) {
        if (!spec.hasOwnProperty(name)) {
          continue;
        }
        if (name === MIXINS_KEY) {
          continue;
        }
        var property = spec[name];
        validateMethodOverride(proto, name);
        if (RESERVED_SPEC_KEYS.hasOwnProperty(name)) {
          RESERVED_SPEC_KEYS[name](Constructor, property);
        } else {
          var isReactClassMethod = ReactClassInterface.hasOwnProperty(name);
          var isAlreadyDefined = proto.hasOwnProperty(name);
          var markedDontBind = property && property.__reactDontBind;
          var isFunction = typeof property === 'function';
          var shouldAutoBind = isFunction && !isReactClassMethod && !isAlreadyDefined && !markedDontBind;
          if (shouldAutoBind) {
            if (!proto.__reactAutoBindMap) {
              proto.__reactAutoBindMap = {};
            }
            proto.__reactAutoBindMap[name] = property;
            proto[name] = property;
          } else {
            if (isAlreadyDefined) {
              var specPolicy = ReactClassInterface[name];
              ("production" !== process.env.NODE_ENV ? invariant(isReactClassMethod && ((specPolicy === SpecPolicy.DEFINE_MANY_MERGED || specPolicy === SpecPolicy.DEFINE_MANY)), 'ReactClass: Unexpected spec policy %s for key %s ' + 'when mixing in component specs.', specPolicy, name) : invariant(isReactClassMethod && ((specPolicy === SpecPolicy.DEFINE_MANY_MERGED || specPolicy === SpecPolicy.DEFINE_MANY))));
              if (specPolicy === SpecPolicy.DEFINE_MANY_MERGED) {
                proto[name] = createMergedResultFunction(proto[name], property);
              } else if (specPolicy === SpecPolicy.DEFINE_MANY) {
                proto[name] = createChainedFunction(proto[name], property);
              }
            } else {
              proto[name] = property;
              if ("production" !== process.env.NODE_ENV) {
                if (typeof property === 'function' && spec.displayName) {
                  proto[name].displayName = spec.displayName + '_' + name;
                }
              }
            }
          }
        }
      }
    }
    function mixStaticSpecIntoComponent(Constructor, statics) {
      if (!statics) {
        return ;
      }
      for (var name in statics) {
        var property = statics[name];
        if (!statics.hasOwnProperty(name)) {
          continue;
        }
        var isReserved = name in RESERVED_SPEC_KEYS;
        ("production" !== process.env.NODE_ENV ? invariant(!isReserved, 'ReactClass: You are attempting to define a reserved ' + 'property, `%s`, that shouldn\'t be on the "statics" key. Define it ' + 'as an instance property instead; it will still be accessible on the ' + 'constructor.', name) : invariant(!isReserved));
        var isInherited = name in Constructor;
        ("production" !== process.env.NODE_ENV ? invariant(!isInherited, 'ReactClass: You are attempting to define ' + '`%s` on your component more than once. This conflict may be ' + 'due to a mixin.', name) : invariant(!isInherited));
        Constructor[name] = property;
      }
    }
    function mergeIntoWithNoDuplicateKeys(one, two) {
      ("production" !== process.env.NODE_ENV ? invariant(one && two && typeof one === 'object' && typeof two === 'object', 'mergeIntoWithNoDuplicateKeys(): Cannot merge non-objects.') : invariant(one && two && typeof one === 'object' && typeof two === 'object'));
      for (var key in two) {
        if (two.hasOwnProperty(key)) {
          ("production" !== process.env.NODE_ENV ? invariant(one[key] === undefined, 'mergeIntoWithNoDuplicateKeys(): ' + 'Tried to merge two objects with the same key: `%s`. This conflict ' + 'may be due to a mixin; in particular, this may be caused by two ' + 'getInitialState() or getDefaultProps() methods returning objects ' + 'with clashing keys.', key) : invariant(one[key] === undefined));
          one[key] = two[key];
        }
      }
      return one;
    }
    function createMergedResultFunction(one, two) {
      return function mergedResult() {
        var a = one.apply(this, arguments);
        var b = two.apply(this, arguments);
        if (a == null) {
          return b;
        } else if (b == null) {
          return a;
        }
        var c = {};
        mergeIntoWithNoDuplicateKeys(c, a);
        mergeIntoWithNoDuplicateKeys(c, b);
        return c;
      };
    }
    function createChainedFunction(one, two) {
      return function chainedFunction() {
        one.apply(this, arguments);
        two.apply(this, arguments);
      };
    }
    function bindAutoBindMethod(component, method) {
      var boundMethod = method.bind(component);
      if ("production" !== process.env.NODE_ENV) {
        boundMethod.__reactBoundContext = component;
        boundMethod.__reactBoundMethod = method;
        boundMethod.__reactBoundArguments = null;
        var componentName = component.constructor.displayName;
        var _bind = boundMethod.bind;
        boundMethod.bind = function(newThis) {
          for (var args = [],
              $__0 = 1,
              $__1 = arguments.length; $__0 < $__1; $__0++)
            args.push(arguments[$__0]);
          if (newThis !== component && newThis !== null) {
            ("production" !== process.env.NODE_ENV ? warning(false, 'bind(): React component methods may only be bound to the ' + 'component instance. See %s', componentName) : null);
          } else if (!args.length) {
            ("production" !== process.env.NODE_ENV ? warning(false, 'bind(): You are binding a component method to the component. ' + 'React does this for you automatically in a high-performance ' + 'way, so you can safely remove this call. See %s', componentName) : null);
            return boundMethod;
          }
          var reboundMethod = _bind.apply(boundMethod, arguments);
          reboundMethod.__reactBoundContext = component;
          reboundMethod.__reactBoundMethod = method;
          reboundMethod.__reactBoundArguments = args;
          return reboundMethod;
        };
      }
      return boundMethod;
    }
    function bindAutoBindMethods(component) {
      for (var autoBindKey in component.__reactAutoBindMap) {
        if (component.__reactAutoBindMap.hasOwnProperty(autoBindKey)) {
          var method = component.__reactAutoBindMap[autoBindKey];
          component[autoBindKey] = bindAutoBindMethod(component, ReactErrorUtils.guard(method, component.constructor.displayName + '.' + autoBindKey));
        }
      }
    }
    var typeDeprecationDescriptor = {
      enumerable: false,
      get: function() {
        var displayName = this.displayName || this.name || 'Component';
        ("production" !== process.env.NODE_ENV ? warning(false, '%s.type is deprecated. Use %s directly to access the class.', displayName, displayName) : null);
        Object.defineProperty(this, 'type', {value: this});
        return this;
      }
    };
    var ReactClassMixin = {
      replaceState: function(newState, callback) {
        ReactUpdateQueue.enqueueReplaceState(this, newState);
        if (callback) {
          ReactUpdateQueue.enqueueCallback(this, callback);
        }
      },
      isMounted: function() {
        if ("production" !== process.env.NODE_ENV) {
          var owner = ReactCurrentOwner.current;
          if (owner !== null) {
            ("production" !== process.env.NODE_ENV ? warning(owner._warnedAboutRefsInRender, '%s is accessing isMounted inside its render() function. ' + 'render() should be a pure function of props and state. It should ' + 'never access something that requires stale data from the previous ' + 'render, such as refs. Move this logic to componentDidMount and ' + 'componentDidUpdate instead.', owner.getName() || 'A component') : null);
            owner._warnedAboutRefsInRender = true;
          }
        }
        var internalInstance = ReactInstanceMap.get(this);
        return (internalInstance && internalInstance !== ReactLifeCycle.currentlyMountingInstance);
      },
      setProps: function(partialProps, callback) {
        ReactUpdateQueue.enqueueSetProps(this, partialProps);
        if (callback) {
          ReactUpdateQueue.enqueueCallback(this, callback);
        }
      },
      replaceProps: function(newProps, callback) {
        ReactUpdateQueue.enqueueReplaceProps(this, newProps);
        if (callback) {
          ReactUpdateQueue.enqueueCallback(this, callback);
        }
      }
    };
    var ReactClassComponent = function() {};
    assign(ReactClassComponent.prototype, ReactComponent.prototype, ReactClassMixin);
    var ReactClass = {
      createClass: function(spec) {
        var Constructor = function(props, context) {
          if ("production" !== process.env.NODE_ENV) {
            ("production" !== process.env.NODE_ENV ? warning(this instanceof Constructor, 'Something is calling a React component directly. Use a factory or ' + 'JSX instead. See: https://fb.me/react-legacyfactory') : null);
          }
          if (this.__reactAutoBindMap) {
            bindAutoBindMethods(this);
          }
          this.props = props;
          this.context = context;
          this.state = null;
          var initialState = this.getInitialState ? this.getInitialState() : null;
          if ("production" !== process.env.NODE_ENV) {
            if (typeof initialState === 'undefined' && this.getInitialState._isMockFunction) {
              initialState = null;
            }
          }
          ("production" !== process.env.NODE_ENV ? invariant(typeof initialState === 'object' && !Array.isArray(initialState), '%s.getInitialState(): must return an object or null', Constructor.displayName || 'ReactCompositeComponent') : invariant(typeof initialState === 'object' && !Array.isArray(initialState)));
          this.state = initialState;
        };
        Constructor.prototype = new ReactClassComponent();
        Constructor.prototype.constructor = Constructor;
        injectedMixins.forEach(mixSpecIntoComponent.bind(null, Constructor));
        mixSpecIntoComponent(Constructor, spec);
        if (Constructor.getDefaultProps) {
          Constructor.defaultProps = Constructor.getDefaultProps();
        }
        if ("production" !== process.env.NODE_ENV) {
          if (Constructor.getDefaultProps) {
            Constructor.getDefaultProps.isReactClassApproved = {};
          }
          if (Constructor.prototype.getInitialState) {
            Constructor.prototype.getInitialState.isReactClassApproved = {};
          }
        }
        ("production" !== process.env.NODE_ENV ? invariant(Constructor.prototype.render, 'createClass(...): Class specification must implement a `render` method.') : invariant(Constructor.prototype.render));
        if ("production" !== process.env.NODE_ENV) {
          ("production" !== process.env.NODE_ENV ? warning(!Constructor.prototype.componentShouldUpdate, '%s has a method called ' + 'componentShouldUpdate(). Did you mean shouldComponentUpdate()? ' + 'The name is phrased as a question because the function is ' + 'expected to return a value.', spec.displayName || 'A component') : null);
        }
        for (var methodName in ReactClassInterface) {
          if (!Constructor.prototype[methodName]) {
            Constructor.prototype[methodName] = null;
          }
        }
        Constructor.type = Constructor;
        if ("production" !== process.env.NODE_ENV) {
          try {
            Object.defineProperty(Constructor, 'type', typeDeprecationDescriptor);
          } catch (x) {}
        }
        return Constructor;
      },
      injection: {injectMixin: function(mixin) {
          injectedMixins.push(mixin);
        }}
    };
    module.exports = ReactClass;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOM", ["npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactElementValidator", "npm:react@0.13.3/lib/mapObject", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactElementValidator = require("npm:react@0.13.3/lib/ReactElementValidator");
    var mapObject = require("npm:react@0.13.3/lib/mapObject");
    function createDOMFactory(tag) {
      if ("production" !== process.env.NODE_ENV) {
        return ReactElementValidator.createFactory(tag);
      }
      return ReactElement.createFactory(tag);
    }
    var ReactDOM = mapObject({
      a: 'a',
      abbr: 'abbr',
      address: 'address',
      area: 'area',
      article: 'article',
      aside: 'aside',
      audio: 'audio',
      b: 'b',
      base: 'base',
      bdi: 'bdi',
      bdo: 'bdo',
      big: 'big',
      blockquote: 'blockquote',
      body: 'body',
      br: 'br',
      button: 'button',
      canvas: 'canvas',
      caption: 'caption',
      cite: 'cite',
      code: 'code',
      col: 'col',
      colgroup: 'colgroup',
      data: 'data',
      datalist: 'datalist',
      dd: 'dd',
      del: 'del',
      details: 'details',
      dfn: 'dfn',
      dialog: 'dialog',
      div: 'div',
      dl: 'dl',
      dt: 'dt',
      em: 'em',
      embed: 'embed',
      fieldset: 'fieldset',
      figcaption: 'figcaption',
      figure: 'figure',
      footer: 'footer',
      form: 'form',
      h1: 'h1',
      h2: 'h2',
      h3: 'h3',
      h4: 'h4',
      h5: 'h5',
      h6: 'h6',
      head: 'head',
      header: 'header',
      hr: 'hr',
      html: 'html',
      i: 'i',
      iframe: 'iframe',
      img: 'img',
      input: 'input',
      ins: 'ins',
      kbd: 'kbd',
      keygen: 'keygen',
      label: 'label',
      legend: 'legend',
      li: 'li',
      link: 'link',
      main: 'main',
      map: 'map',
      mark: 'mark',
      menu: 'menu',
      menuitem: 'menuitem',
      meta: 'meta',
      meter: 'meter',
      nav: 'nav',
      noscript: 'noscript',
      object: 'object',
      ol: 'ol',
      optgroup: 'optgroup',
      option: 'option',
      output: 'output',
      p: 'p',
      param: 'param',
      picture: 'picture',
      pre: 'pre',
      progress: 'progress',
      q: 'q',
      rp: 'rp',
      rt: 'rt',
      ruby: 'ruby',
      s: 's',
      samp: 'samp',
      script: 'script',
      section: 'section',
      select: 'select',
      small: 'small',
      source: 'source',
      span: 'span',
      strong: 'strong',
      style: 'style',
      sub: 'sub',
      summary: 'summary',
      sup: 'sup',
      table: 'table',
      tbody: 'tbody',
      td: 'td',
      textarea: 'textarea',
      tfoot: 'tfoot',
      th: 'th',
      thead: 'thead',
      time: 'time',
      title: 'title',
      tr: 'tr',
      track: 'track',
      u: 'u',
      ul: 'ul',
      'var': 'var',
      video: 'video',
      wbr: 'wbr',
      circle: 'circle',
      clipPath: 'clipPath',
      defs: 'defs',
      ellipse: 'ellipse',
      g: 'g',
      line: 'line',
      linearGradient: 'linearGradient',
      mask: 'mask',
      path: 'path',
      pattern: 'pattern',
      polygon: 'polygon',
      polyline: 'polyline',
      radialGradient: 'radialGradient',
      rect: 'rect',
      stop: 'stop',
      svg: 'svg',
      text: 'text',
      tspan: 'tspan'
    }, createDOMFactory);
    module.exports = ReactDOM;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/quoteAttributeValueForBrowser", ["npm:react@0.13.3/lib/escapeTextContentForBrowser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var escapeTextContentForBrowser = require("npm:react@0.13.3/lib/escapeTextContentForBrowser");
  function quoteAttributeValueForBrowser(value) {
    return '"' + escapeTextContentForBrowser(value) + '"';
  }
  module.exports = quoteAttributeValueForBrowser;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/camelizeStyleName", ["npm:react@0.13.3/lib/camelize"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var camelize = require("npm:react@0.13.3/lib/camelize");
  var msPattern = /^-ms-/;
  function camelizeStyleName(string) {
    return camelize(string.replace(msPattern, 'ms-'));
  }
  module.exports = camelizeStyleName;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/hyphenateStyleName", ["npm:react@0.13.3/lib/hyphenate"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var hyphenate = require("npm:react@0.13.3/lib/hyphenate");
  var msPattern = /^ms-/;
  function hyphenateStyleName(string) {
    return hyphenate(string).replace(msPattern, '-ms-');
  }
  module.exports = hyphenateStyleName;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/createArrayFromMixed", ["npm:react@0.13.3/lib/toArray"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var toArray = require("npm:react@0.13.3/lib/toArray");
  function hasArrayNature(obj) {
    return (!!obj && (typeof obj == 'object' || typeof obj == 'function') && ('length' in obj) && !('setInterval' in obj) && (typeof obj.nodeType != 'number') && (((Array.isArray(obj) || ('callee' in obj) || 'item' in obj))));
  }
  function createArrayFromMixed(obj) {
    if (!hasArrayNature(obj)) {
      return [obj];
    } else if (Array.isArray(obj)) {
      return obj.slice();
    } else {
      return toArray(obj);
    }
  }
  module.exports = createArrayFromMixed;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/setTextContent", ["npm:react@0.13.3/lib/ExecutionEnvironment", "npm:react@0.13.3/lib/escapeTextContentForBrowser", "npm:react@0.13.3/lib/setInnerHTML"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
  var escapeTextContentForBrowser = require("npm:react@0.13.3/lib/escapeTextContentForBrowser");
  var setInnerHTML = require("npm:react@0.13.3/lib/setInnerHTML");
  var setTextContent = function(node, text) {
    node.textContent = text;
  };
  if (ExecutionEnvironment.canUseDOM) {
    if (!('textContent' in document.documentElement)) {
      setTextContent = function(node, text) {
        setInnerHTML(node, escapeTextContentForBrowser(text));
      };
    }
  }
  module.exports = setTextContent;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/EventPluginHub", ["npm:react@0.13.3/lib/EventPluginRegistry", "npm:react@0.13.3/lib/EventPluginUtils", "npm:react@0.13.3/lib/accumulateInto", "npm:react@0.13.3/lib/forEachAccumulated", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var EventPluginRegistry = require("npm:react@0.13.3/lib/EventPluginRegistry");
    var EventPluginUtils = require("npm:react@0.13.3/lib/EventPluginUtils");
    var accumulateInto = require("npm:react@0.13.3/lib/accumulateInto");
    var forEachAccumulated = require("npm:react@0.13.3/lib/forEachAccumulated");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var listenerBank = {};
    var eventQueue = null;
    var executeDispatchesAndRelease = function(event) {
      if (event) {
        var executeDispatch = EventPluginUtils.executeDispatch;
        var PluginModule = EventPluginRegistry.getPluginModuleForEvent(event);
        if (PluginModule && PluginModule.executeDispatch) {
          executeDispatch = PluginModule.executeDispatch;
        }
        EventPluginUtils.executeDispatchesInOrder(event, executeDispatch);
        if (!event.isPersistent()) {
          event.constructor.release(event);
        }
      }
    };
    var InstanceHandle = null;
    function validateInstanceHandle() {
      var valid = InstanceHandle && InstanceHandle.traverseTwoPhase && InstanceHandle.traverseEnterLeave;
      ("production" !== process.env.NODE_ENV ? invariant(valid, 'InstanceHandle not injected before use!') : invariant(valid));
    }
    var EventPluginHub = {
      injection: {
        injectMount: EventPluginUtils.injection.injectMount,
        injectInstanceHandle: function(InjectedInstanceHandle) {
          InstanceHandle = InjectedInstanceHandle;
          if ("production" !== process.env.NODE_ENV) {
            validateInstanceHandle();
          }
        },
        getInstanceHandle: function() {
          if ("production" !== process.env.NODE_ENV) {
            validateInstanceHandle();
          }
          return InstanceHandle;
        },
        injectEventPluginOrder: EventPluginRegistry.injectEventPluginOrder,
        injectEventPluginsByName: EventPluginRegistry.injectEventPluginsByName
      },
      eventNameDispatchConfigs: EventPluginRegistry.eventNameDispatchConfigs,
      registrationNameModules: EventPluginRegistry.registrationNameModules,
      putListener: function(id, registrationName, listener) {
        ("production" !== process.env.NODE_ENV ? invariant(!listener || typeof listener === 'function', 'Expected %s listener to be a function, instead got type %s', registrationName, typeof listener) : invariant(!listener || typeof listener === 'function'));
        var bankForRegistrationName = listenerBank[registrationName] || (listenerBank[registrationName] = {});
        bankForRegistrationName[id] = listener;
      },
      getListener: function(id, registrationName) {
        var bankForRegistrationName = listenerBank[registrationName];
        return bankForRegistrationName && bankForRegistrationName[id];
      },
      deleteListener: function(id, registrationName) {
        var bankForRegistrationName = listenerBank[registrationName];
        if (bankForRegistrationName) {
          delete bankForRegistrationName[id];
        }
      },
      deleteAllListeners: function(id) {
        for (var registrationName in listenerBank) {
          delete listenerBank[registrationName][id];
        }
      },
      extractEvents: function(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent) {
        var events;
        var plugins = EventPluginRegistry.plugins;
        for (var i = 0,
            l = plugins.length; i < l; i++) {
          var possiblePlugin = plugins[i];
          if (possiblePlugin) {
            var extractedEvents = possiblePlugin.extractEvents(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent);
            if (extractedEvents) {
              events = accumulateInto(events, extractedEvents);
            }
          }
        }
        return events;
      },
      enqueueEvents: function(events) {
        if (events) {
          eventQueue = accumulateInto(eventQueue, events);
        }
      },
      processEventQueue: function() {
        var processingEventQueue = eventQueue;
        eventQueue = null;
        forEachAccumulated(processingEventQueue, executeDispatchesAndRelease);
        ("production" !== process.env.NODE_ENV ? invariant(!eventQueue, 'processEventQueue(): Additional events were enqueued while processing ' + 'an event queue. Support for this has not yet been implemented.') : invariant(!eventQueue));
      },
      __purge: function() {
        listenerBank = {};
      },
      __getListenerBank: function() {
        return listenerBank;
      }
    };
    module.exports = EventPluginHub;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactMarkupChecksum", ["npm:react@0.13.3/lib/adler32"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var adler32 = require("npm:react@0.13.3/lib/adler32");
  var ReactMarkupChecksum = {
    CHECKSUM_ATTR_NAME: 'data-react-checksum',
    addChecksumToMarkup: function(markup) {
      var checksum = adler32(markup);
      return markup.replace('>', ' ' + ReactMarkupChecksum.CHECKSUM_ATTR_NAME + '="' + checksum + '">');
    },
    canReuseMarkup: function(markup, element) {
      var existingChecksum = element.getAttribute(ReactMarkupChecksum.CHECKSUM_ATTR_NAME);
      existingChecksum = existingChecksum && parseInt(existingChecksum, 10);
      var markupChecksum = adler32(markup);
      return markupChecksum === existingChecksum;
    }
  };
  module.exports = ReactMarkupChecksum;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/isTextNode", ["npm:react@0.13.3/lib/isNode"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isNode = require("npm:react@0.13.3/lib/isNode");
  function isTextNode(object) {
    return isNode(object) && object.nodeType == 3;
  }
  module.exports = isTextNode;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactCompositeComponent", ["npm:react@0.13.3/lib/ReactComponentEnvironment", "npm:react@0.13.3/lib/ReactContext", "npm:react@0.13.3/lib/ReactCurrentOwner", "npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactElementValidator", "npm:react@0.13.3/lib/ReactInstanceMap", "npm:react@0.13.3/lib/ReactLifeCycle", "npm:react@0.13.3/lib/ReactNativeComponent", "npm:react@0.13.3/lib/ReactPerf", "npm:react@0.13.3/lib/ReactPropTypeLocations", "npm:react@0.13.3/lib/ReactPropTypeLocationNames", "npm:react@0.13.3/lib/ReactReconciler", "npm:react@0.13.3/lib/ReactUpdates", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/emptyObject", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/shouldUpdateReactComponent", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactComponentEnvironment = require("npm:react@0.13.3/lib/ReactComponentEnvironment");
    var ReactContext = require("npm:react@0.13.3/lib/ReactContext");
    var ReactCurrentOwner = require("npm:react@0.13.3/lib/ReactCurrentOwner");
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactElementValidator = require("npm:react@0.13.3/lib/ReactElementValidator");
    var ReactInstanceMap = require("npm:react@0.13.3/lib/ReactInstanceMap");
    var ReactLifeCycle = require("npm:react@0.13.3/lib/ReactLifeCycle");
    var ReactNativeComponent = require("npm:react@0.13.3/lib/ReactNativeComponent");
    var ReactPerf = require("npm:react@0.13.3/lib/ReactPerf");
    var ReactPropTypeLocations = require("npm:react@0.13.3/lib/ReactPropTypeLocations");
    var ReactPropTypeLocationNames = require("npm:react@0.13.3/lib/ReactPropTypeLocationNames");
    var ReactReconciler = require("npm:react@0.13.3/lib/ReactReconciler");
    var ReactUpdates = require("npm:react@0.13.3/lib/ReactUpdates");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var emptyObject = require("npm:react@0.13.3/lib/emptyObject");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var shouldUpdateReactComponent = require("npm:react@0.13.3/lib/shouldUpdateReactComponent");
    var warning = require("npm:react@0.13.3/lib/warning");
    function getDeclarationErrorAddendum(component) {
      var owner = component._currentElement._owner || null;
      if (owner) {
        var name = owner.getName();
        if (name) {
          return ' Check the render method of `' + name + '`.';
        }
      }
      return '';
    }
    var nextMountID = 1;
    var ReactCompositeComponentMixin = {
      construct: function(element) {
        this._currentElement = element;
        this._rootNodeID = null;
        this._instance = null;
        this._pendingElement = null;
        this._pendingStateQueue = null;
        this._pendingReplaceState = false;
        this._pendingForceUpdate = false;
        this._renderedComponent = null;
        this._context = null;
        this._mountOrder = 0;
        this._isTopLevel = false;
        this._pendingCallbacks = null;
      },
      mountComponent: function(rootID, transaction, context) {
        this._context = context;
        this._mountOrder = nextMountID++;
        this._rootNodeID = rootID;
        var publicProps = this._processProps(this._currentElement.props);
        var publicContext = this._processContext(this._currentElement._context);
        var Component = ReactNativeComponent.getComponentClassForElement(this._currentElement);
        var inst = new Component(publicProps, publicContext);
        if ("production" !== process.env.NODE_ENV) {
          ("production" !== process.env.NODE_ENV ? warning(inst.render != null, '%s(...): No `render` method found on the returned component ' + 'instance: you may have forgotten to define `render` in your ' + 'component or you may have accidentally tried to render an element ' + 'whose type is a function that isn\'t a React component.', Component.displayName || Component.name || 'Component') : null);
        }
        inst.props = publicProps;
        inst.context = publicContext;
        inst.refs = emptyObject;
        this._instance = inst;
        ReactInstanceMap.set(inst, this);
        if ("production" !== process.env.NODE_ENV) {
          this._warnIfContextsDiffer(this._currentElement._context, context);
        }
        if ("production" !== process.env.NODE_ENV) {
          ("production" !== process.env.NODE_ENV ? warning(!inst.getInitialState || inst.getInitialState.isReactClassApproved, 'getInitialState was defined on %s, a plain JavaScript class. ' + 'This is only supported for classes created using React.createClass. ' + 'Did you mean to define a state property instead?', this.getName() || 'a component') : null);
          ("production" !== process.env.NODE_ENV ? warning(!inst.getDefaultProps || inst.getDefaultProps.isReactClassApproved, 'getDefaultProps was defined on %s, a plain JavaScript class. ' + 'This is only supported for classes created using React.createClass. ' + 'Use a static property to define defaultProps instead.', this.getName() || 'a component') : null);
          ("production" !== process.env.NODE_ENV ? warning(!inst.propTypes, 'propTypes was defined as an instance property on %s. Use a static ' + 'property to define propTypes instead.', this.getName() || 'a component') : null);
          ("production" !== process.env.NODE_ENV ? warning(!inst.contextTypes, 'contextTypes was defined as an instance property on %s. Use a ' + 'static property to define contextTypes instead.', this.getName() || 'a component') : null);
          ("production" !== process.env.NODE_ENV ? warning(typeof inst.componentShouldUpdate !== 'function', '%s has a method called ' + 'componentShouldUpdate(). Did you mean shouldComponentUpdate()? ' + 'The name is phrased as a question because the function is ' + 'expected to return a value.', (this.getName() || 'A component')) : null);
        }
        var initialState = inst.state;
        if (initialState === undefined) {
          inst.state = initialState = null;
        }
        ("production" !== process.env.NODE_ENV ? invariant(typeof initialState === 'object' && !Array.isArray(initialState), '%s.state: must be set to an object or null', this.getName() || 'ReactCompositeComponent') : invariant(typeof initialState === 'object' && !Array.isArray(initialState)));
        this._pendingStateQueue = null;
        this._pendingReplaceState = false;
        this._pendingForceUpdate = false;
        var childContext;
        var renderedElement;
        var previouslyMounting = ReactLifeCycle.currentlyMountingInstance;
        ReactLifeCycle.currentlyMountingInstance = this;
        try {
          if (inst.componentWillMount) {
            inst.componentWillMount();
            if (this._pendingStateQueue) {
              inst.state = this._processPendingState(inst.props, inst.context);
            }
          }
          childContext = this._getValidatedChildContext(context);
          renderedElement = this._renderValidatedComponent(childContext);
        } finally {
          ReactLifeCycle.currentlyMountingInstance = previouslyMounting;
        }
        this._renderedComponent = this._instantiateReactComponent(renderedElement, this._currentElement.type);
        var markup = ReactReconciler.mountComponent(this._renderedComponent, rootID, transaction, this._mergeChildContext(context, childContext));
        if (inst.componentDidMount) {
          transaction.getReactMountReady().enqueue(inst.componentDidMount, inst);
        }
        return markup;
      },
      unmountComponent: function() {
        var inst = this._instance;
        if (inst.componentWillUnmount) {
          var previouslyUnmounting = ReactLifeCycle.currentlyUnmountingInstance;
          ReactLifeCycle.currentlyUnmountingInstance = this;
          try {
            inst.componentWillUnmount();
          } finally {
            ReactLifeCycle.currentlyUnmountingInstance = previouslyUnmounting;
          }
        }
        ReactReconciler.unmountComponent(this._renderedComponent);
        this._renderedComponent = null;
        this._pendingStateQueue = null;
        this._pendingReplaceState = false;
        this._pendingForceUpdate = false;
        this._pendingCallbacks = null;
        this._pendingElement = null;
        this._context = null;
        this._rootNodeID = null;
        ReactInstanceMap.remove(inst);
      },
      _setPropsInternal: function(partialProps, callback) {
        var element = this._pendingElement || this._currentElement;
        this._pendingElement = ReactElement.cloneAndReplaceProps(element, assign({}, element.props, partialProps));
        ReactUpdates.enqueueUpdate(this, callback);
      },
      _maskContext: function(context) {
        var maskedContext = null;
        if (typeof this._currentElement.type === 'string') {
          return emptyObject;
        }
        var contextTypes = this._currentElement.type.contextTypes;
        if (!contextTypes) {
          return emptyObject;
        }
        maskedContext = {};
        for (var contextName in contextTypes) {
          maskedContext[contextName] = context[contextName];
        }
        return maskedContext;
      },
      _processContext: function(context) {
        var maskedContext = this._maskContext(context);
        if ("production" !== process.env.NODE_ENV) {
          var Component = ReactNativeComponent.getComponentClassForElement(this._currentElement);
          if (Component.contextTypes) {
            this._checkPropTypes(Component.contextTypes, maskedContext, ReactPropTypeLocations.context);
          }
        }
        return maskedContext;
      },
      _getValidatedChildContext: function(currentContext) {
        var inst = this._instance;
        var childContext = inst.getChildContext && inst.getChildContext();
        if (childContext) {
          ("production" !== process.env.NODE_ENV ? invariant(typeof inst.constructor.childContextTypes === 'object', '%s.getChildContext(): childContextTypes must be defined in order to ' + 'use getChildContext().', this.getName() || 'ReactCompositeComponent') : invariant(typeof inst.constructor.childContextTypes === 'object'));
          if ("production" !== process.env.NODE_ENV) {
            this._checkPropTypes(inst.constructor.childContextTypes, childContext, ReactPropTypeLocations.childContext);
          }
          for (var name in childContext) {
            ("production" !== process.env.NODE_ENV ? invariant(name in inst.constructor.childContextTypes, '%s.getChildContext(): key "%s" is not defined in childContextTypes.', this.getName() || 'ReactCompositeComponent', name) : invariant(name in inst.constructor.childContextTypes));
          }
          return childContext;
        }
        return null;
      },
      _mergeChildContext: function(currentContext, childContext) {
        if (childContext) {
          return assign({}, currentContext, childContext);
        }
        return currentContext;
      },
      _processProps: function(newProps) {
        if ("production" !== process.env.NODE_ENV) {
          var Component = ReactNativeComponent.getComponentClassForElement(this._currentElement);
          if (Component.propTypes) {
            this._checkPropTypes(Component.propTypes, newProps, ReactPropTypeLocations.prop);
          }
        }
        return newProps;
      },
      _checkPropTypes: function(propTypes, props, location) {
        var componentName = this.getName();
        for (var propName in propTypes) {
          if (propTypes.hasOwnProperty(propName)) {
            var error;
            try {
              ("production" !== process.env.NODE_ENV ? invariant(typeof propTypes[propName] === 'function', '%s: %s type `%s` is invalid; it must be a function, usually ' + 'from React.PropTypes.', componentName || 'React class', ReactPropTypeLocationNames[location], propName) : invariant(typeof propTypes[propName] === 'function'));
              error = propTypes[propName](props, propName, componentName, location);
            } catch (ex) {
              error = ex;
            }
            if (error instanceof Error) {
              var addendum = getDeclarationErrorAddendum(this);
              if (location === ReactPropTypeLocations.prop) {
                ("production" !== process.env.NODE_ENV ? warning(false, 'Failed Composite propType: %s%s', error.message, addendum) : null);
              } else {
                ("production" !== process.env.NODE_ENV ? warning(false, 'Failed Context Types: %s%s', error.message, addendum) : null);
              }
            }
          }
        }
      },
      receiveComponent: function(nextElement, transaction, nextContext) {
        var prevElement = this._currentElement;
        var prevContext = this._context;
        this._pendingElement = null;
        this.updateComponent(transaction, prevElement, nextElement, prevContext, nextContext);
      },
      performUpdateIfNecessary: function(transaction) {
        if (this._pendingElement != null) {
          ReactReconciler.receiveComponent(this, this._pendingElement || this._currentElement, transaction, this._context);
        }
        if (this._pendingStateQueue !== null || this._pendingForceUpdate) {
          if ("production" !== process.env.NODE_ENV) {
            ReactElementValidator.checkAndWarnForMutatedProps(this._currentElement);
          }
          this.updateComponent(transaction, this._currentElement, this._currentElement, this._context, this._context);
        }
      },
      _warnIfContextsDiffer: function(ownerBasedContext, parentBasedContext) {
        ownerBasedContext = this._maskContext(ownerBasedContext);
        parentBasedContext = this._maskContext(parentBasedContext);
        var parentKeys = Object.keys(parentBasedContext).sort();
        var displayName = this.getName() || 'ReactCompositeComponent';
        for (var i = 0; i < parentKeys.length; i++) {
          var key = parentKeys[i];
          ("production" !== process.env.NODE_ENV ? warning(ownerBasedContext[key] === parentBasedContext[key], 'owner-based and parent-based contexts differ ' + '(values: `%s` vs `%s`) for key (%s) while mounting %s ' + '(see: http://fb.me/react-context-by-parent)', ownerBasedContext[key], parentBasedContext[key], key, displayName) : null);
        }
      },
      updateComponent: function(transaction, prevParentElement, nextParentElement, prevUnmaskedContext, nextUnmaskedContext) {
        var inst = this._instance;
        var nextContext = inst.context;
        var nextProps = inst.props;
        if (prevParentElement !== nextParentElement) {
          nextContext = this._processContext(nextParentElement._context);
          nextProps = this._processProps(nextParentElement.props);
          if ("production" !== process.env.NODE_ENV) {
            if (nextUnmaskedContext != null) {
              this._warnIfContextsDiffer(nextParentElement._context, nextUnmaskedContext);
            }
          }
          if (inst.componentWillReceiveProps) {
            inst.componentWillReceiveProps(nextProps, nextContext);
          }
        }
        var nextState = this._processPendingState(nextProps, nextContext);
        var shouldUpdate = this._pendingForceUpdate || !inst.shouldComponentUpdate || inst.shouldComponentUpdate(nextProps, nextState, nextContext);
        if ("production" !== process.env.NODE_ENV) {
          ("production" !== process.env.NODE_ENV ? warning(typeof shouldUpdate !== 'undefined', '%s.shouldComponentUpdate(): Returned undefined instead of a ' + 'boolean value. Make sure to return true or false.', this.getName() || 'ReactCompositeComponent') : null);
        }
        if (shouldUpdate) {
          this._pendingForceUpdate = false;
          this._performComponentUpdate(nextParentElement, nextProps, nextState, nextContext, transaction, nextUnmaskedContext);
        } else {
          this._currentElement = nextParentElement;
          this._context = nextUnmaskedContext;
          inst.props = nextProps;
          inst.state = nextState;
          inst.context = nextContext;
        }
      },
      _processPendingState: function(props, context) {
        var inst = this._instance;
        var queue = this._pendingStateQueue;
        var replace = this._pendingReplaceState;
        this._pendingReplaceState = false;
        this._pendingStateQueue = null;
        if (!queue) {
          return inst.state;
        }
        if (replace && queue.length === 1) {
          return queue[0];
        }
        var nextState = assign({}, replace ? queue[0] : inst.state);
        for (var i = replace ? 1 : 0; i < queue.length; i++) {
          var partial = queue[i];
          assign(nextState, typeof partial === 'function' ? partial.call(inst, nextState, props, context) : partial);
        }
        return nextState;
      },
      _performComponentUpdate: function(nextElement, nextProps, nextState, nextContext, transaction, unmaskedContext) {
        var inst = this._instance;
        var prevProps = inst.props;
        var prevState = inst.state;
        var prevContext = inst.context;
        if (inst.componentWillUpdate) {
          inst.componentWillUpdate(nextProps, nextState, nextContext);
        }
        this._currentElement = nextElement;
        this._context = unmaskedContext;
        inst.props = nextProps;
        inst.state = nextState;
        inst.context = nextContext;
        this._updateRenderedComponent(transaction, unmaskedContext);
        if (inst.componentDidUpdate) {
          transaction.getReactMountReady().enqueue(inst.componentDidUpdate.bind(inst, prevProps, prevState, prevContext), inst);
        }
      },
      _updateRenderedComponent: function(transaction, context) {
        var prevComponentInstance = this._renderedComponent;
        var prevRenderedElement = prevComponentInstance._currentElement;
        var childContext = this._getValidatedChildContext();
        var nextRenderedElement = this._renderValidatedComponent(childContext);
        if (shouldUpdateReactComponent(prevRenderedElement, nextRenderedElement)) {
          ReactReconciler.receiveComponent(prevComponentInstance, nextRenderedElement, transaction, this._mergeChildContext(context, childContext));
        } else {
          var thisID = this._rootNodeID;
          var prevComponentID = prevComponentInstance._rootNodeID;
          ReactReconciler.unmountComponent(prevComponentInstance);
          this._renderedComponent = this._instantiateReactComponent(nextRenderedElement, this._currentElement.type);
          var nextMarkup = ReactReconciler.mountComponent(this._renderedComponent, thisID, transaction, this._mergeChildContext(context, childContext));
          this._replaceNodeWithMarkupByID(prevComponentID, nextMarkup);
        }
      },
      _replaceNodeWithMarkupByID: function(prevComponentID, nextMarkup) {
        ReactComponentEnvironment.replaceNodeWithMarkupByID(prevComponentID, nextMarkup);
      },
      _renderValidatedComponentWithoutOwnerOrContext: function() {
        var inst = this._instance;
        var renderedComponent = inst.render();
        if ("production" !== process.env.NODE_ENV) {
          if (typeof renderedComponent === 'undefined' && inst.render._isMockFunction) {
            renderedComponent = null;
          }
        }
        return renderedComponent;
      },
      _renderValidatedComponent: function(childContext) {
        var renderedComponent;
        var previousContext = ReactContext.current;
        ReactContext.current = this._mergeChildContext(this._currentElement._context, childContext);
        ReactCurrentOwner.current = this;
        try {
          renderedComponent = this._renderValidatedComponentWithoutOwnerOrContext();
        } finally {
          ReactContext.current = previousContext;
          ReactCurrentOwner.current = null;
        }
        ("production" !== process.env.NODE_ENV ? invariant(renderedComponent === null || renderedComponent === false || ReactElement.isValidElement(renderedComponent), '%s.render(): A valid ReactComponent must be returned. You may have ' + 'returned undefined, an array or some other invalid object.', this.getName() || 'ReactCompositeComponent') : invariant(renderedComponent === null || renderedComponent === false || ReactElement.isValidElement(renderedComponent)));
        return renderedComponent;
      },
      attachRef: function(ref, component) {
        var inst = this.getPublicInstance();
        var refs = inst.refs === emptyObject ? (inst.refs = {}) : inst.refs;
        refs[ref] = component.getPublicInstance();
      },
      detachRef: function(ref) {
        var refs = this.getPublicInstance().refs;
        delete refs[ref];
      },
      getName: function() {
        var type = this._currentElement.type;
        var constructor = this._instance && this._instance.constructor;
        return (type.displayName || (constructor && constructor.displayName) || type.name || (constructor && constructor.name) || null);
      },
      getPublicInstance: function() {
        return this._instance;
      },
      _instantiateReactComponent: null
    };
    ReactPerf.measureMethods(ReactCompositeComponentMixin, 'ReactCompositeComponent', {
      mountComponent: 'mountComponent',
      updateComponent: 'updateComponent',
      _renderValidatedComponent: '_renderValidatedComponent'
    });
    var ReactCompositeComponent = {Mixin: ReactCompositeComponentMixin};
    module.exports = ReactCompositeComponent;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactChildReconciler", ["npm:react@0.13.3/lib/ReactReconciler", "npm:react@0.13.3/lib/flattenChildren", "npm:react@0.13.3/lib/instantiateReactComponent", "npm:react@0.13.3/lib/shouldUpdateReactComponent"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ReactReconciler = require("npm:react@0.13.3/lib/ReactReconciler");
  var flattenChildren = require("npm:react@0.13.3/lib/flattenChildren");
  var instantiateReactComponent = require("npm:react@0.13.3/lib/instantiateReactComponent");
  var shouldUpdateReactComponent = require("npm:react@0.13.3/lib/shouldUpdateReactComponent");
  var ReactChildReconciler = {
    instantiateChildren: function(nestedChildNodes, transaction, context) {
      var children = flattenChildren(nestedChildNodes);
      for (var name in children) {
        if (children.hasOwnProperty(name)) {
          var child = children[name];
          var childInstance = instantiateReactComponent(child, null);
          children[name] = childInstance;
        }
      }
      return children;
    },
    updateChildren: function(prevChildren, nextNestedChildNodes, transaction, context) {
      var nextChildren = flattenChildren(nextNestedChildNodes);
      if (!nextChildren && !prevChildren) {
        return null;
      }
      var name;
      for (name in nextChildren) {
        if (!nextChildren.hasOwnProperty(name)) {
          continue;
        }
        var prevChild = prevChildren && prevChildren[name];
        var prevElement = prevChild && prevChild._currentElement;
        var nextElement = nextChildren[name];
        if (shouldUpdateReactComponent(prevElement, nextElement)) {
          ReactReconciler.receiveComponent(prevChild, nextElement, transaction, context);
          nextChildren[name] = prevChild;
        } else {
          if (prevChild) {
            ReactReconciler.unmountComponent(prevChild, name);
          }
          var nextChildInstance = instantiateReactComponent(nextElement, null);
          nextChildren[name] = nextChildInstance;
        }
      }
      for (name in prevChildren) {
        if (prevChildren.hasOwnProperty(name) && !(nextChildren && nextChildren.hasOwnProperty(name))) {
          ReactReconciler.unmountComponent(prevChildren[name]);
        }
      }
      return nextChildren;
    },
    unmountChildren: function(renderedChildren) {
      for (var name in renderedChildren) {
        var renderedChild = renderedChildren[name];
        ReactReconciler.unmountComponent(renderedChild);
      }
    }
  };
  module.exports = ReactChildReconciler;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/FallbackCompositionState", ["npm:react@0.13.3/lib/PooledClass", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/getTextContentAccessor"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var PooledClass = require("npm:react@0.13.3/lib/PooledClass");
  var assign = require("npm:react@0.13.3/lib/Object.assign");
  var getTextContentAccessor = require("npm:react@0.13.3/lib/getTextContentAccessor");
  function FallbackCompositionState(root) {
    this._root = root;
    this._startText = this.getText();
    this._fallbackText = null;
  }
  assign(FallbackCompositionState.prototype, {
    getText: function() {
      if ('value' in this._root) {
        return this._root.value;
      }
      return this._root[getTextContentAccessor()];
    },
    getData: function() {
      if (this._fallbackText) {
        return this._fallbackText;
      }
      var start;
      var startValue = this._startText;
      var startLength = startValue.length;
      var end;
      var endValue = this.getText();
      var endLength = endValue.length;
      for (start = 0; start < startLength; start++) {
        if (startValue[start] !== endValue[start]) {
          break;
        }
      }
      var minEnd = startLength - start;
      for (end = 1; end <= minEnd; end++) {
        if (startValue[startLength - end] !== endValue[endLength - end]) {
          break;
        }
      }
      var sliceTail = end > 1 ? 1 - end : undefined;
      this._fallbackText = endValue.slice(start, sliceTail);
      return this._fallbackText;
    }
  });
  PooledClass.addPoolingTo(FallbackCompositionState);
  module.exports = FallbackCompositionState;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SyntheticEvent", ["npm:react@0.13.3/lib/PooledClass", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/emptyFunction", "npm:react@0.13.3/lib/getEventTarget"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var PooledClass = require("npm:react@0.13.3/lib/PooledClass");
  var assign = require("npm:react@0.13.3/lib/Object.assign");
  var emptyFunction = require("npm:react@0.13.3/lib/emptyFunction");
  var getEventTarget = require("npm:react@0.13.3/lib/getEventTarget");
  var EventInterface = {
    type: null,
    target: getEventTarget,
    currentTarget: emptyFunction.thatReturnsNull,
    eventPhase: null,
    bubbles: null,
    cancelable: null,
    timeStamp: function(event) {
      return event.timeStamp || Date.now();
    },
    defaultPrevented: null,
    isTrusted: null
  };
  function SyntheticEvent(dispatchConfig, dispatchMarker, nativeEvent) {
    this.dispatchConfig = dispatchConfig;
    this.dispatchMarker = dispatchMarker;
    this.nativeEvent = nativeEvent;
    var Interface = this.constructor.Interface;
    for (var propName in Interface) {
      if (!Interface.hasOwnProperty(propName)) {
        continue;
      }
      var normalize = Interface[propName];
      if (normalize) {
        this[propName] = normalize(nativeEvent);
      } else {
        this[propName] = nativeEvent[propName];
      }
    }
    var defaultPrevented = nativeEvent.defaultPrevented != null ? nativeEvent.defaultPrevented : nativeEvent.returnValue === false;
    if (defaultPrevented) {
      this.isDefaultPrevented = emptyFunction.thatReturnsTrue;
    } else {
      this.isDefaultPrevented = emptyFunction.thatReturnsFalse;
    }
    this.isPropagationStopped = emptyFunction.thatReturnsFalse;
  }
  assign(SyntheticEvent.prototype, {
    preventDefault: function() {
      this.defaultPrevented = true;
      var event = this.nativeEvent;
      if (event.preventDefault) {
        event.preventDefault();
      } else {
        event.returnValue = false;
      }
      this.isDefaultPrevented = emptyFunction.thatReturnsTrue;
    },
    stopPropagation: function() {
      var event = this.nativeEvent;
      if (event.stopPropagation) {
        event.stopPropagation();
      } else {
        event.cancelBubble = true;
      }
      this.isPropagationStopped = emptyFunction.thatReturnsTrue;
    },
    persist: function() {
      this.isPersistent = emptyFunction.thatReturnsTrue;
    },
    isPersistent: emptyFunction.thatReturnsFalse,
    destructor: function() {
      var Interface = this.constructor.Interface;
      for (var propName in Interface) {
        this[propName] = null;
      }
      this.dispatchConfig = null;
      this.dispatchMarker = null;
      this.nativeEvent = null;
    }
  });
  SyntheticEvent.Interface = EventInterface;
  SyntheticEvent.augmentClass = function(Class, Interface) {
    var Super = this;
    var prototype = Object.create(Super.prototype);
    assign(prototype, Class.prototype);
    Class.prototype = prototype;
    Class.prototype.constructor = Class;
    Class.Interface = assign({}, Super.Interface, Interface);
    Class.augmentClass = Super.augmentClass;
    PooledClass.addPoolingTo(Class, PooledClass.threeArgumentPooler);
  };
  PooledClass.addPoolingTo(SyntheticEvent, PooledClass.threeArgumentPooler);
  module.exports = SyntheticEvent;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ChangeEventPlugin", ["npm:react@0.13.3/lib/EventConstants", "npm:react@0.13.3/lib/EventPluginHub", "npm:react@0.13.3/lib/EventPropagators", "npm:react@0.13.3/lib/ExecutionEnvironment", "npm:react@0.13.3/lib/ReactUpdates", "npm:react@0.13.3/lib/SyntheticEvent", "npm:react@0.13.3/lib/isEventSupported", "npm:react@0.13.3/lib/isTextInputElement", "npm:react@0.13.3/lib/keyOf", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var EventConstants = require("npm:react@0.13.3/lib/EventConstants");
    var EventPluginHub = require("npm:react@0.13.3/lib/EventPluginHub");
    var EventPropagators = require("npm:react@0.13.3/lib/EventPropagators");
    var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
    var ReactUpdates = require("npm:react@0.13.3/lib/ReactUpdates");
    var SyntheticEvent = require("npm:react@0.13.3/lib/SyntheticEvent");
    var isEventSupported = require("npm:react@0.13.3/lib/isEventSupported");
    var isTextInputElement = require("npm:react@0.13.3/lib/isTextInputElement");
    var keyOf = require("npm:react@0.13.3/lib/keyOf");
    var topLevelTypes = EventConstants.topLevelTypes;
    var eventTypes = {change: {
        phasedRegistrationNames: {
          bubbled: keyOf({onChange: null}),
          captured: keyOf({onChangeCapture: null})
        },
        dependencies: [topLevelTypes.topBlur, topLevelTypes.topChange, topLevelTypes.topClick, topLevelTypes.topFocus, topLevelTypes.topInput, topLevelTypes.topKeyDown, topLevelTypes.topKeyUp, topLevelTypes.topSelectionChange]
      }};
    var activeElement = null;
    var activeElementID = null;
    var activeElementValue = null;
    var activeElementValueProp = null;
    function shouldUseChangeEvent(elem) {
      return (elem.nodeName === 'SELECT' || (elem.nodeName === 'INPUT' && elem.type === 'file'));
    }
    var doesChangeEventBubble = false;
    if (ExecutionEnvironment.canUseDOM) {
      doesChangeEventBubble = isEventSupported('change') && ((!('documentMode' in document) || document.documentMode > 8));
    }
    function manualDispatchChangeEvent(nativeEvent) {
      var event = SyntheticEvent.getPooled(eventTypes.change, activeElementID, nativeEvent);
      EventPropagators.accumulateTwoPhaseDispatches(event);
      ReactUpdates.batchedUpdates(runEventInBatch, event);
    }
    function runEventInBatch(event) {
      EventPluginHub.enqueueEvents(event);
      EventPluginHub.processEventQueue();
    }
    function startWatchingForChangeEventIE8(target, targetID) {
      activeElement = target;
      activeElementID = targetID;
      activeElement.attachEvent('onchange', manualDispatchChangeEvent);
    }
    function stopWatchingForChangeEventIE8() {
      if (!activeElement) {
        return ;
      }
      activeElement.detachEvent('onchange', manualDispatchChangeEvent);
      activeElement = null;
      activeElementID = null;
    }
    function getTargetIDForChangeEvent(topLevelType, topLevelTarget, topLevelTargetID) {
      if (topLevelType === topLevelTypes.topChange) {
        return topLevelTargetID;
      }
    }
    function handleEventsForChangeEventIE8(topLevelType, topLevelTarget, topLevelTargetID) {
      if (topLevelType === topLevelTypes.topFocus) {
        stopWatchingForChangeEventIE8();
        startWatchingForChangeEventIE8(topLevelTarget, topLevelTargetID);
      } else if (topLevelType === topLevelTypes.topBlur) {
        stopWatchingForChangeEventIE8();
      }
    }
    var isInputEventSupported = false;
    if (ExecutionEnvironment.canUseDOM) {
      isInputEventSupported = isEventSupported('input') && ((!('documentMode' in document) || document.documentMode > 9));
    }
    var newValueProp = {
      get: function() {
        return activeElementValueProp.get.call(this);
      },
      set: function(val) {
        activeElementValue = '' + val;
        activeElementValueProp.set.call(this, val);
      }
    };
    function startWatchingForValueChange(target, targetID) {
      activeElement = target;
      activeElementID = targetID;
      activeElementValue = target.value;
      activeElementValueProp = Object.getOwnPropertyDescriptor(target.constructor.prototype, 'value');
      Object.defineProperty(activeElement, 'value', newValueProp);
      activeElement.attachEvent('onpropertychange', handlePropertyChange);
    }
    function stopWatchingForValueChange() {
      if (!activeElement) {
        return ;
      }
      delete activeElement.value;
      activeElement.detachEvent('onpropertychange', handlePropertyChange);
      activeElement = null;
      activeElementID = null;
      activeElementValue = null;
      activeElementValueProp = null;
    }
    function handlePropertyChange(nativeEvent) {
      if (nativeEvent.propertyName !== 'value') {
        return ;
      }
      var value = nativeEvent.srcElement.value;
      if (value === activeElementValue) {
        return ;
      }
      activeElementValue = value;
      manualDispatchChangeEvent(nativeEvent);
    }
    function getTargetIDForInputEvent(topLevelType, topLevelTarget, topLevelTargetID) {
      if (topLevelType === topLevelTypes.topInput) {
        return topLevelTargetID;
      }
    }
    function handleEventsForInputEventIE(topLevelType, topLevelTarget, topLevelTargetID) {
      if (topLevelType === topLevelTypes.topFocus) {
        stopWatchingForValueChange();
        startWatchingForValueChange(topLevelTarget, topLevelTargetID);
      } else if (topLevelType === topLevelTypes.topBlur) {
        stopWatchingForValueChange();
      }
    }
    function getTargetIDForInputEventIE(topLevelType, topLevelTarget, topLevelTargetID) {
      if (topLevelType === topLevelTypes.topSelectionChange || topLevelType === topLevelTypes.topKeyUp || topLevelType === topLevelTypes.topKeyDown) {
        if (activeElement && activeElement.value !== activeElementValue) {
          activeElementValue = activeElement.value;
          return activeElementID;
        }
      }
    }
    function shouldUseClickEvent(elem) {
      return (elem.nodeName === 'INPUT' && (elem.type === 'checkbox' || elem.type === 'radio'));
    }
    function getTargetIDForClickEvent(topLevelType, topLevelTarget, topLevelTargetID) {
      if (topLevelType === topLevelTypes.topClick) {
        return topLevelTargetID;
      }
    }
    var ChangeEventPlugin = {
      eventTypes: eventTypes,
      extractEvents: function(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent) {
        var getTargetIDFunc,
            handleEventFunc;
        if (shouldUseChangeEvent(topLevelTarget)) {
          if (doesChangeEventBubble) {
            getTargetIDFunc = getTargetIDForChangeEvent;
          } else {
            handleEventFunc = handleEventsForChangeEventIE8;
          }
        } else if (isTextInputElement(topLevelTarget)) {
          if (isInputEventSupported) {
            getTargetIDFunc = getTargetIDForInputEvent;
          } else {
            getTargetIDFunc = getTargetIDForInputEventIE;
            handleEventFunc = handleEventsForInputEventIE;
          }
        } else if (shouldUseClickEvent(topLevelTarget)) {
          getTargetIDFunc = getTargetIDForClickEvent;
        }
        if (getTargetIDFunc) {
          var targetID = getTargetIDFunc(topLevelType, topLevelTarget, topLevelTargetID);
          if (targetID) {
            var event = SyntheticEvent.getPooled(eventTypes.change, targetID, nativeEvent);
            EventPropagators.accumulateTwoPhaseDispatches(event);
            return event;
          }
        }
        if (handleEventFunc) {
          handleEventFunc(topLevelType, topLevelTarget, topLevelTargetID);
        }
      }
    };
    module.exports = ChangeEventPlugin;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SyntheticMouseEvent", ["npm:react@0.13.3/lib/SyntheticUIEvent", "npm:react@0.13.3/lib/ViewportMetrics", "npm:react@0.13.3/lib/getEventModifierState"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var SyntheticUIEvent = require("npm:react@0.13.3/lib/SyntheticUIEvent");
  var ViewportMetrics = require("npm:react@0.13.3/lib/ViewportMetrics");
  var getEventModifierState = require("npm:react@0.13.3/lib/getEventModifierState");
  var MouseEventInterface = {
    screenX: null,
    screenY: null,
    clientX: null,
    clientY: null,
    ctrlKey: null,
    shiftKey: null,
    altKey: null,
    metaKey: null,
    getModifierState: getEventModifierState,
    button: function(event) {
      var button = event.button;
      if ('which' in event) {
        return button;
      }
      return button === 2 ? 2 : button === 4 ? 1 : 0;
    },
    buttons: null,
    relatedTarget: function(event) {
      return event.relatedTarget || (((event.fromElement === event.srcElement ? event.toElement : event.fromElement)));
    },
    pageX: function(event) {
      return 'pageX' in event ? event.pageX : event.clientX + ViewportMetrics.currentScrollLeft;
    },
    pageY: function(event) {
      return 'pageY' in event ? event.pageY : event.clientY + ViewportMetrics.currentScrollTop;
    }
  };
  function SyntheticMouseEvent(dispatchConfig, dispatchMarker, nativeEvent) {
    SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
  }
  SyntheticUIEvent.augmentClass(SyntheticMouseEvent, MouseEventInterface);
  module.exports = SyntheticMouseEvent;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactBrowserComponentMixin", ["npm:react@0.13.3/lib/findDOMNode"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var findDOMNode = require("npm:react@0.13.3/lib/findDOMNode");
  var ReactBrowserComponentMixin = {getDOMNode: function() {
      return findDOMNode(this);
    }};
  module.exports = ReactBrowserComponentMixin;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/AutoFocusMixin", ["npm:react@0.13.3/lib/focusNode"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var focusNode = require("npm:react@0.13.3/lib/focusNode");
  var AutoFocusMixin = {componentDidMount: function() {
      if (this.props.autoFocus) {
        focusNode(this.getDOMNode());
      }
    }};
  module.exports = AutoFocusMixin;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOMForm", ["npm:react@0.13.3/lib/EventConstants", "npm:react@0.13.3/lib/LocalEventTrapMixin", "npm:react@0.13.3/lib/ReactBrowserComponentMixin", "npm:react@0.13.3/lib/ReactClass", "npm:react@0.13.3/lib/ReactElement"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var EventConstants = require("npm:react@0.13.3/lib/EventConstants");
  var LocalEventTrapMixin = require("npm:react@0.13.3/lib/LocalEventTrapMixin");
  var ReactBrowserComponentMixin = require("npm:react@0.13.3/lib/ReactBrowserComponentMixin");
  var ReactClass = require("npm:react@0.13.3/lib/ReactClass");
  var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
  var form = ReactElement.createFactory('form');
  var ReactDOMForm = ReactClass.createClass({
    displayName: 'ReactDOMForm',
    tagName: 'FORM',
    mixins: [ReactBrowserComponentMixin, LocalEventTrapMixin],
    render: function() {
      return form(this.props);
    },
    componentDidMount: function() {
      this.trapBubbledEvent(EventConstants.topLevelTypes.topReset, 'reset');
      this.trapBubbledEvent(EventConstants.topLevelTypes.topSubmit, 'submit');
    }
  });
  module.exports = ReactDOMForm;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/LinkedValueUtils", ["npm:react@0.13.3/lib/ReactPropTypes", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactPropTypes = require("npm:react@0.13.3/lib/ReactPropTypes");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var hasReadOnlyValue = {
      'button': true,
      'checkbox': true,
      'image': true,
      'hidden': true,
      'radio': true,
      'reset': true,
      'submit': true
    };
    function _assertSingleLink(input) {
      ("production" !== process.env.NODE_ENV ? invariant(input.props.checkedLink == null || input.props.valueLink == null, 'Cannot provide a checkedLink and a valueLink. If you want to use ' + 'checkedLink, you probably don\'t want to use valueLink and vice versa.') : invariant(input.props.checkedLink == null || input.props.valueLink == null));
    }
    function _assertValueLink(input) {
      _assertSingleLink(input);
      ("production" !== process.env.NODE_ENV ? invariant(input.props.value == null && input.props.onChange == null, 'Cannot provide a valueLink and a value or onChange event. If you want ' + 'to use value or onChange, you probably don\'t want to use valueLink.') : invariant(input.props.value == null && input.props.onChange == null));
    }
    function _assertCheckedLink(input) {
      _assertSingleLink(input);
      ("production" !== process.env.NODE_ENV ? invariant(input.props.checked == null && input.props.onChange == null, 'Cannot provide a checkedLink and a checked property or onChange event. ' + 'If you want to use checked or onChange, you probably don\'t want to ' + 'use checkedLink') : invariant(input.props.checked == null && input.props.onChange == null));
    }
    function _handleLinkedValueChange(e) {
      this.props.valueLink.requestChange(e.target.value);
    }
    function _handleLinkedCheckChange(e) {
      this.props.checkedLink.requestChange(e.target.checked);
    }
    var LinkedValueUtils = {
      Mixin: {propTypes: {
          value: function(props, propName, componentName) {
            if (!props[propName] || hasReadOnlyValue[props.type] || props.onChange || props.readOnly || props.disabled) {
              return null;
            }
            return new Error('You provided a `value` prop to a form field without an ' + '`onChange` handler. This will render a read-only field. If ' + 'the field should be mutable use `defaultValue`. Otherwise, ' + 'set either `onChange` or `readOnly`.');
          },
          checked: function(props, propName, componentName) {
            if (!props[propName] || props.onChange || props.readOnly || props.disabled) {
              return null;
            }
            return new Error('You provided a `checked` prop to a form field without an ' + '`onChange` handler. This will render a read-only field. If ' + 'the field should be mutable use `defaultChecked`. Otherwise, ' + 'set either `onChange` or `readOnly`.');
          },
          onChange: ReactPropTypes.func
        }},
      getValue: function(input) {
        if (input.props.valueLink) {
          _assertValueLink(input);
          return input.props.valueLink.value;
        }
        return input.props.value;
      },
      getChecked: function(input) {
        if (input.props.checkedLink) {
          _assertCheckedLink(input);
          return input.props.checkedLink.value;
        }
        return input.props.checked;
      },
      getOnChange: function(input) {
        if (input.props.valueLink) {
          _assertValueLink(input);
          return _handleLinkedValueChange;
        } else if (input.props.checkedLink) {
          _assertCheckedLink(input);
          return _handleLinkedCheckChange;
        }
        return input.props.onChange;
      }
    };
    module.exports = LinkedValueUtils;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactEventListener", ["npm:react@0.13.3/lib/EventListener", "npm:react@0.13.3/lib/ExecutionEnvironment", "npm:react@0.13.3/lib/PooledClass", "npm:react@0.13.3/lib/ReactInstanceHandles", "npm:react@0.13.3/lib/ReactMount", "npm:react@0.13.3/lib/ReactUpdates", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/getEventTarget", "npm:react@0.13.3/lib/getUnboundedScrollPosition", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var EventListener = require("npm:react@0.13.3/lib/EventListener");
    var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
    var PooledClass = require("npm:react@0.13.3/lib/PooledClass");
    var ReactInstanceHandles = require("npm:react@0.13.3/lib/ReactInstanceHandles");
    var ReactMount = require("npm:react@0.13.3/lib/ReactMount");
    var ReactUpdates = require("npm:react@0.13.3/lib/ReactUpdates");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var getEventTarget = require("npm:react@0.13.3/lib/getEventTarget");
    var getUnboundedScrollPosition = require("npm:react@0.13.3/lib/getUnboundedScrollPosition");
    function findParent(node) {
      var nodeID = ReactMount.getID(node);
      var rootID = ReactInstanceHandles.getReactRootIDFromNodeID(nodeID);
      var container = ReactMount.findReactContainerForID(rootID);
      var parent = ReactMount.getFirstReactDOM(container);
      return parent;
    }
    function TopLevelCallbackBookKeeping(topLevelType, nativeEvent) {
      this.topLevelType = topLevelType;
      this.nativeEvent = nativeEvent;
      this.ancestors = [];
    }
    assign(TopLevelCallbackBookKeeping.prototype, {destructor: function() {
        this.topLevelType = null;
        this.nativeEvent = null;
        this.ancestors.length = 0;
      }});
    PooledClass.addPoolingTo(TopLevelCallbackBookKeeping, PooledClass.twoArgumentPooler);
    function handleTopLevelImpl(bookKeeping) {
      var topLevelTarget = ReactMount.getFirstReactDOM(getEventTarget(bookKeeping.nativeEvent)) || window;
      var ancestor = topLevelTarget;
      while (ancestor) {
        bookKeeping.ancestors.push(ancestor);
        ancestor = findParent(ancestor);
      }
      for (var i = 0,
          l = bookKeeping.ancestors.length; i < l; i++) {
        topLevelTarget = bookKeeping.ancestors[i];
        var topLevelTargetID = ReactMount.getID(topLevelTarget) || '';
        ReactEventListener._handleTopLevel(bookKeeping.topLevelType, topLevelTarget, topLevelTargetID, bookKeeping.nativeEvent);
      }
    }
    function scrollValueMonitor(cb) {
      var scrollPosition = getUnboundedScrollPosition(window);
      cb(scrollPosition);
    }
    var ReactEventListener = {
      _enabled: true,
      _handleTopLevel: null,
      WINDOW_HANDLE: ExecutionEnvironment.canUseDOM ? window : null,
      setHandleTopLevel: function(handleTopLevel) {
        ReactEventListener._handleTopLevel = handleTopLevel;
      },
      setEnabled: function(enabled) {
        ReactEventListener._enabled = !!enabled;
      },
      isEnabled: function() {
        return ReactEventListener._enabled;
      },
      trapBubbledEvent: function(topLevelType, handlerBaseName, handle) {
        var element = handle;
        if (!element) {
          return null;
        }
        return EventListener.listen(element, handlerBaseName, ReactEventListener.dispatchEvent.bind(null, topLevelType));
      },
      trapCapturedEvent: function(topLevelType, handlerBaseName, handle) {
        var element = handle;
        if (!element) {
          return null;
        }
        return EventListener.capture(element, handlerBaseName, ReactEventListener.dispatchEvent.bind(null, topLevelType));
      },
      monitorScrollValue: function(refresh) {
        var callback = scrollValueMonitor.bind(null, refresh);
        EventListener.listen(window, 'scroll', callback);
      },
      dispatchEvent: function(topLevelType, nativeEvent) {
        if (!ReactEventListener._enabled) {
          return ;
        }
        var bookKeeping = TopLevelCallbackBookKeeping.getPooled(topLevelType, nativeEvent);
        try {
          ReactUpdates.batchedUpdates(handleTopLevelImpl, bookKeeping);
        } finally {
          TopLevelCallbackBookKeeping.release(bookKeeping);
        }
      }
    };
    module.exports = ReactEventListener;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOMSelection", ["npm:react@0.13.3/lib/ExecutionEnvironment", "npm:react@0.13.3/lib/getNodeForCharacterOffset", "npm:react@0.13.3/lib/getTextContentAccessor"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
  var getNodeForCharacterOffset = require("npm:react@0.13.3/lib/getNodeForCharacterOffset");
  var getTextContentAccessor = require("npm:react@0.13.3/lib/getTextContentAccessor");
  function isCollapsed(anchorNode, anchorOffset, focusNode, focusOffset) {
    return anchorNode === focusNode && anchorOffset === focusOffset;
  }
  function getIEOffsets(node) {
    var selection = document.selection;
    var selectedRange = selection.createRange();
    var selectedLength = selectedRange.text.length;
    var fromStart = selectedRange.duplicate();
    fromStart.moveToElementText(node);
    fromStart.setEndPoint('EndToStart', selectedRange);
    var startOffset = fromStart.text.length;
    var endOffset = startOffset + selectedLength;
    return {
      start: startOffset,
      end: endOffset
    };
  }
  function getModernOffsets(node) {
    var selection = window.getSelection && window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    var anchorNode = selection.anchorNode;
    var anchorOffset = selection.anchorOffset;
    var focusNode = selection.focusNode;
    var focusOffset = selection.focusOffset;
    var currentRange = selection.getRangeAt(0);
    var isSelectionCollapsed = isCollapsed(selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset);
    var rangeLength = isSelectionCollapsed ? 0 : currentRange.toString().length;
    var tempRange = currentRange.cloneRange();
    tempRange.selectNodeContents(node);
    tempRange.setEnd(currentRange.startContainer, currentRange.startOffset);
    var isTempRangeCollapsed = isCollapsed(tempRange.startContainer, tempRange.startOffset, tempRange.endContainer, tempRange.endOffset);
    var start = isTempRangeCollapsed ? 0 : tempRange.toString().length;
    var end = start + rangeLength;
    var detectionRange = document.createRange();
    detectionRange.setStart(anchorNode, anchorOffset);
    detectionRange.setEnd(focusNode, focusOffset);
    var isBackward = detectionRange.collapsed;
    return {
      start: isBackward ? end : start,
      end: isBackward ? start : end
    };
  }
  function setIEOffsets(node, offsets) {
    var range = document.selection.createRange().duplicate();
    var start,
        end;
    if (typeof offsets.end === 'undefined') {
      start = offsets.start;
      end = start;
    } else if (offsets.start > offsets.end) {
      start = offsets.end;
      end = offsets.start;
    } else {
      start = offsets.start;
      end = offsets.end;
    }
    range.moveToElementText(node);
    range.moveStart('character', start);
    range.setEndPoint('EndToStart', range);
    range.moveEnd('character', end - start);
    range.select();
  }
  function setModernOffsets(node, offsets) {
    if (!window.getSelection) {
      return ;
    }
    var selection = window.getSelection();
    var length = node[getTextContentAccessor()].length;
    var start = Math.min(offsets.start, length);
    var end = typeof offsets.end === 'undefined' ? start : Math.min(offsets.end, length);
    if (!selection.extend && start > end) {
      var temp = end;
      end = start;
      start = temp;
    }
    var startMarker = getNodeForCharacterOffset(node, start);
    var endMarker = getNodeForCharacterOffset(node, end);
    if (startMarker && endMarker) {
      var range = document.createRange();
      range.setStart(startMarker.node, startMarker.offset);
      selection.removeAllRanges();
      if (start > end) {
        selection.addRange(range);
        selection.extend(endMarker.node, endMarker.offset);
      } else {
        range.setEnd(endMarker.node, endMarker.offset);
        selection.addRange(range);
      }
    }
  }
  var useIEOffsets = (ExecutionEnvironment.canUseDOM && 'selection' in document && !('getSelection' in window));
  var ReactDOMSelection = {
    getOffsets: useIEOffsets ? getIEOffsets : getModernOffsets,
    setOffsets: useIEOffsets ? setIEOffsets : setModernOffsets
  };
  module.exports = ReactDOMSelection;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SelectEventPlugin", ["npm:react@0.13.3/lib/EventConstants", "npm:react@0.13.3/lib/EventPropagators", "npm:react@0.13.3/lib/ReactInputSelection", "npm:react@0.13.3/lib/SyntheticEvent", "npm:react@0.13.3/lib/getActiveElement", "npm:react@0.13.3/lib/isTextInputElement", "npm:react@0.13.3/lib/keyOf", "npm:react@0.13.3/lib/shallowEqual"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var EventConstants = require("npm:react@0.13.3/lib/EventConstants");
  var EventPropagators = require("npm:react@0.13.3/lib/EventPropagators");
  var ReactInputSelection = require("npm:react@0.13.3/lib/ReactInputSelection");
  var SyntheticEvent = require("npm:react@0.13.3/lib/SyntheticEvent");
  var getActiveElement = require("npm:react@0.13.3/lib/getActiveElement");
  var isTextInputElement = require("npm:react@0.13.3/lib/isTextInputElement");
  var keyOf = require("npm:react@0.13.3/lib/keyOf");
  var shallowEqual = require("npm:react@0.13.3/lib/shallowEqual");
  var topLevelTypes = EventConstants.topLevelTypes;
  var eventTypes = {select: {
      phasedRegistrationNames: {
        bubbled: keyOf({onSelect: null}),
        captured: keyOf({onSelectCapture: null})
      },
      dependencies: [topLevelTypes.topBlur, topLevelTypes.topContextMenu, topLevelTypes.topFocus, topLevelTypes.topKeyDown, topLevelTypes.topMouseDown, topLevelTypes.topMouseUp, topLevelTypes.topSelectionChange]
    }};
  var activeElement = null;
  var activeElementID = null;
  var lastSelection = null;
  var mouseDown = false;
  function getSelection(node) {
    if ('selectionStart' in node && ReactInputSelection.hasSelectionCapabilities(node)) {
      return {
        start: node.selectionStart,
        end: node.selectionEnd
      };
    } else if (window.getSelection) {
      var selection = window.getSelection();
      return {
        anchorNode: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode,
        focusOffset: selection.focusOffset
      };
    } else if (document.selection) {
      var range = document.selection.createRange();
      return {
        parentElement: range.parentElement(),
        text: range.text,
        top: range.boundingTop,
        left: range.boundingLeft
      };
    }
  }
  function constructSelectEvent(nativeEvent) {
    if (mouseDown || activeElement == null || activeElement !== getActiveElement()) {
      return null;
    }
    var currentSelection = getSelection(activeElement);
    if (!lastSelection || !shallowEqual(lastSelection, currentSelection)) {
      lastSelection = currentSelection;
      var syntheticEvent = SyntheticEvent.getPooled(eventTypes.select, activeElementID, nativeEvent);
      syntheticEvent.type = 'select';
      syntheticEvent.target = activeElement;
      EventPropagators.accumulateTwoPhaseDispatches(syntheticEvent);
      return syntheticEvent;
    }
  }
  var SelectEventPlugin = {
    eventTypes: eventTypes,
    extractEvents: function(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent) {
      switch (topLevelType) {
        case topLevelTypes.topFocus:
          if (isTextInputElement(topLevelTarget) || topLevelTarget.contentEditable === 'true') {
            activeElement = topLevelTarget;
            activeElementID = topLevelTargetID;
            lastSelection = null;
          }
          break;
        case topLevelTypes.topBlur:
          activeElement = null;
          activeElementID = null;
          lastSelection = null;
          break;
        case topLevelTypes.topMouseDown:
          mouseDown = true;
          break;
        case topLevelTypes.topContextMenu:
        case topLevelTypes.topMouseUp:
          mouseDown = false;
          return constructSelectEvent(nativeEvent);
        case topLevelTypes.topSelectionChange:
        case topLevelTypes.topKeyDown:
        case topLevelTypes.topKeyUp:
          return constructSelectEvent(nativeEvent);
      }
    }
  };
  module.exports = SelectEventPlugin;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SyntheticKeyboardEvent", ["npm:react@0.13.3/lib/SyntheticUIEvent", "npm:react@0.13.3/lib/getEventCharCode", "npm:react@0.13.3/lib/getEventKey", "npm:react@0.13.3/lib/getEventModifierState"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var SyntheticUIEvent = require("npm:react@0.13.3/lib/SyntheticUIEvent");
  var getEventCharCode = require("npm:react@0.13.3/lib/getEventCharCode");
  var getEventKey = require("npm:react@0.13.3/lib/getEventKey");
  var getEventModifierState = require("npm:react@0.13.3/lib/getEventModifierState");
  var KeyboardEventInterface = {
    key: getEventKey,
    location: null,
    ctrlKey: null,
    shiftKey: null,
    altKey: null,
    metaKey: null,
    repeat: null,
    locale: null,
    getModifierState: getEventModifierState,
    charCode: function(event) {
      if (event.type === 'keypress') {
        return getEventCharCode(event);
      }
      return 0;
    },
    keyCode: function(event) {
      if (event.type === 'keydown' || event.type === 'keyup') {
        return event.keyCode;
      }
      return 0;
    },
    which: function(event) {
      if (event.type === 'keypress') {
        return getEventCharCode(event);
      }
      if (event.type === 'keydown' || event.type === 'keyup') {
        return event.keyCode;
      }
      return 0;
    }
  };
  function SyntheticKeyboardEvent(dispatchConfig, dispatchMarker, nativeEvent) {
    SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
  }
  SyntheticUIEvent.augmentClass(SyntheticKeyboardEvent, KeyboardEventInterface);
  module.exports = SyntheticKeyboardEvent;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/performanceNow", ["npm:react@0.13.3/lib/performance"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var performance = require("npm:react@0.13.3/lib/performance");
  if (!performance || !performance.now) {
    performance = Date;
  }
  var performanceNow = performance.now.bind(performance);
  module.exports = performanceNow;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactServerRendering", ["npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactInstanceHandles", "npm:react@0.13.3/lib/ReactMarkupChecksum", "npm:react@0.13.3/lib/ReactServerRenderingTransaction", "npm:react@0.13.3/lib/emptyObject", "npm:react@0.13.3/lib/instantiateReactComponent", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactInstanceHandles = require("npm:react@0.13.3/lib/ReactInstanceHandles");
    var ReactMarkupChecksum = require("npm:react@0.13.3/lib/ReactMarkupChecksum");
    var ReactServerRenderingTransaction = require("npm:react@0.13.3/lib/ReactServerRenderingTransaction");
    var emptyObject = require("npm:react@0.13.3/lib/emptyObject");
    var instantiateReactComponent = require("npm:react@0.13.3/lib/instantiateReactComponent");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    function renderToString(element) {
      ("production" !== process.env.NODE_ENV ? invariant(ReactElement.isValidElement(element), 'renderToString(): You must pass a valid ReactElement.') : invariant(ReactElement.isValidElement(element)));
      var transaction;
      try {
        var id = ReactInstanceHandles.createReactRootID();
        transaction = ReactServerRenderingTransaction.getPooled(false);
        return transaction.perform(function() {
          var componentInstance = instantiateReactComponent(element, null);
          var markup = componentInstance.mountComponent(id, transaction, emptyObject);
          return ReactMarkupChecksum.addChecksumToMarkup(markup);
        }, null);
      } finally {
        ReactServerRenderingTransaction.release(transaction);
      }
    }
    function renderToStaticMarkup(element) {
      ("production" !== process.env.NODE_ENV ? invariant(ReactElement.isValidElement(element), 'renderToStaticMarkup(): You must pass a valid ReactElement.') : invariant(ReactElement.isValidElement(element)));
      var transaction;
      try {
        var id = ReactInstanceHandles.createReactRootID();
        transaction = ReactServerRenderingTransaction.getPooled(true);
        return transaction.perform(function() {
          var componentInstance = instantiateReactComponent(element, null);
          return componentInstance.mountComponent(id, transaction, emptyObject);
        }, null);
      } finally {
        ReactServerRenderingTransaction.release(transaction);
      }
    }
    module.exports = {
      renderToString: renderToString,
      renderToStaticMarkup: renderToStaticMarkup
    };
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/function/debounce", ["npm:lodash@3.9.1/lang/isObject", "npm:lodash@3.9.1/date/now"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isObject = require("npm:lodash@3.9.1/lang/isObject"),
      now = require("npm:lodash@3.9.1/date/now");
  var FUNC_ERROR_TEXT = 'Expected a function';
  var nativeMax = Math.max;
  function debounce(func, wait, options) {
    var args,
        maxTimeoutId,
        result,
        stamp,
        thisArg,
        timeoutId,
        trailingCall,
        lastCalled = 0,
        maxWait = false,
        trailing = true;
    if (typeof func != 'function') {
      throw new TypeError(FUNC_ERROR_TEXT);
    }
    wait = wait < 0 ? 0 : (+wait || 0);
    if (options === true) {
      var leading = true;
      trailing = false;
    } else if (isObject(options)) {
      leading = options.leading;
      maxWait = 'maxWait' in options && nativeMax(+options.maxWait || 0, wait);
      trailing = 'trailing' in options ? options.trailing : trailing;
    }
    function cancel() {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (maxTimeoutId) {
        clearTimeout(maxTimeoutId);
      }
      maxTimeoutId = timeoutId = trailingCall = undefined;
    }
    function delayed() {
      var remaining = wait - (now() - stamp);
      if (remaining <= 0 || remaining > wait) {
        if (maxTimeoutId) {
          clearTimeout(maxTimeoutId);
        }
        var isCalled = trailingCall;
        maxTimeoutId = timeoutId = trailingCall = undefined;
        if (isCalled) {
          lastCalled = now();
          result = func.apply(thisArg, args);
          if (!timeoutId && !maxTimeoutId) {
            args = thisArg = null;
          }
        }
      } else {
        timeoutId = setTimeout(delayed, remaining);
      }
    }
    function maxDelayed() {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      maxTimeoutId = timeoutId = trailingCall = undefined;
      if (trailing || (maxWait !== wait)) {
        lastCalled = now();
        result = func.apply(thisArg, args);
        if (!timeoutId && !maxTimeoutId) {
          args = thisArg = null;
        }
      }
    }
    function debounced() {
      args = arguments;
      stamp = now();
      thisArg = this;
      trailingCall = trailing && (timeoutId || !leading);
      if (maxWait === false) {
        var leadingCall = leading && !timeoutId;
      } else {
        if (!maxTimeoutId && !leading) {
          lastCalled = stamp;
        }
        var remaining = maxWait - (stamp - lastCalled),
            isCalled = remaining <= 0 || remaining > maxWait;
        if (isCalled) {
          if (maxTimeoutId) {
            maxTimeoutId = clearTimeout(maxTimeoutId);
          }
          lastCalled = stamp;
          result = func.apply(thisArg, args);
        } else if (!maxTimeoutId) {
          maxTimeoutId = setTimeout(maxDelayed, remaining);
        }
      }
      if (isCalled && timeoutId) {
        timeoutId = clearTimeout(timeoutId);
      } else if (!timeoutId && wait !== maxWait) {
        timeoutId = setTimeout(delayed, wait);
      }
      if (leadingCall) {
        isCalled = true;
        result = func.apply(thisArg, args);
      }
      if (isCalled && !timeoutId && !maxTimeoutId) {
        args = thisArg = null;
      }
      return result;
    }
    debounced.cancel = cancel;
    return debounced;
  }
  module.exports = debounce;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseEach", ["npm:lodash@3.9.1/internal/baseForOwn", "npm:lodash@3.9.1/internal/createBaseEach"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseForOwn = require("npm:lodash@3.9.1/internal/baseForOwn"),
      createBaseEach = require("npm:lodash@3.9.1/internal/createBaseEach");
  var baseEach = createBaseEach(baseForOwn);
  module.exports = baseEach;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/equalArrays", ["npm:lodash@3.9.1/internal/arraySome"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var arraySome = require("npm:lodash@3.9.1/internal/arraySome");
  function equalArrays(array, other, equalFunc, customizer, isLoose, stackA, stackB) {
    var index = -1,
        arrLength = array.length,
        othLength = other.length;
    if (arrLength != othLength && !(isLoose && othLength > arrLength)) {
      return false;
    }
    while (++index < arrLength) {
      var arrValue = array[index],
          othValue = other[index],
          result = customizer ? customizer(isLoose ? othValue : arrValue, isLoose ? arrValue : othValue, index) : undefined;
      if (result !== undefined) {
        if (result) {
          continue;
        }
        return false;
      }
      if (isLoose) {
        if (!arraySome(other, function(othValue) {
          return arrValue === othValue || equalFunc(arrValue, othValue, customizer, isLoose, stackA, stackB);
        })) {
          return false;
        }
      } else if (!(arrValue === othValue || equalFunc(arrValue, othValue, customizer, isLoose, stackA, stackB))) {
        return false;
      }
    }
    return true;
  }
  module.exports = equalArrays;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/getMatchData", ["npm:lodash@3.9.1/internal/isStrictComparable", "npm:lodash@3.9.1/object/pairs"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isStrictComparable = require("npm:lodash@3.9.1/internal/isStrictComparable"),
      pairs = require("npm:lodash@3.9.1/object/pairs");
  function getMatchData(object) {
    var result = pairs(object),
        length = result.length;
    while (length--) {
      result[length][2] = isStrictComparable(result[length][1]);
    }
    return result;
  }
  module.exports = getMatchData;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseMatchesProperty", ["npm:lodash@3.9.1/internal/baseGet", "npm:lodash@3.9.1/internal/baseIsEqual", "npm:lodash@3.9.1/internal/baseSlice", "npm:lodash@3.9.1/lang/isArray", "npm:lodash@3.9.1/internal/isKey", "npm:lodash@3.9.1/internal/isStrictComparable", "npm:lodash@3.9.1/array/last", "npm:lodash@3.9.1/internal/toObject", "npm:lodash@3.9.1/internal/toPath"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseGet = require("npm:lodash@3.9.1/internal/baseGet"),
      baseIsEqual = require("npm:lodash@3.9.1/internal/baseIsEqual"),
      baseSlice = require("npm:lodash@3.9.1/internal/baseSlice"),
      isArray = require("npm:lodash@3.9.1/lang/isArray"),
      isKey = require("npm:lodash@3.9.1/internal/isKey"),
      isStrictComparable = require("npm:lodash@3.9.1/internal/isStrictComparable"),
      last = require("npm:lodash@3.9.1/array/last"),
      toObject = require("npm:lodash@3.9.1/internal/toObject"),
      toPath = require("npm:lodash@3.9.1/internal/toPath");
  function baseMatchesProperty(path, srcValue) {
    var isArr = isArray(path),
        isCommon = isKey(path) && isStrictComparable(srcValue),
        pathKey = (path + '');
    path = toPath(path);
    return function(object) {
      if (object == null) {
        return false;
      }
      var key = pathKey;
      object = toObject(object);
      if ((isArr || !isCommon) && !(key in object)) {
        object = path.length == 1 ? object : baseGet(object, baseSlice(path, 0, -1));
        if (object == null) {
          return false;
        }
        key = last(path);
        object = toObject(object);
      }
      return object[key] === srcValue ? (srcValue !== undefined || (key in object)) : baseIsEqual(srcValue, object[key], undefined, true);
    };
  }
  module.exports = baseMatchesProperty;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/utility/property", ["npm:lodash@3.9.1/internal/baseProperty", "npm:lodash@3.9.1/internal/basePropertyDeep", "npm:lodash@3.9.1/internal/isKey"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseProperty = require("npm:lodash@3.9.1/internal/baseProperty"),
      basePropertyDeep = require("npm:lodash@3.9.1/internal/basePropertyDeep"),
      isKey = require("npm:lodash@3.9.1/internal/isKey");
  function property(path) {
    return isKey(path) ? baseProperty(path) : basePropertyDeep(path);
  }
  module.exports = property;
  global.define = __define;
  return module.exports;
});



System.register("npm:color-convert@0.5.2/index", ["npm:color-convert@0.5.2/conversions"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var conversions = require("npm:color-convert@0.5.2/conversions");
  var convert = function() {
    return new Converter();
  };
  for (var func in conversions) {
    convert[func + "Raw"] = (function(func) {
      return function(arg) {
        if (typeof arg == "number")
          arg = Array.prototype.slice.call(arguments);
        return conversions[func](arg);
      };
    })(func);
    var pair = /(\w+)2(\w+)/.exec(func),
        from = pair[1],
        to = pair[2];
    convert[from] = convert[from] || {};
    convert[from][to] = convert[func] = (function(func) {
      return function(arg) {
        if (typeof arg == "number")
          arg = Array.prototype.slice.call(arguments);
        var val = conversions[func](arg);
        if (typeof val == "string" || val === undefined)
          return val;
        for (var i = 0; i < val.length; i++)
          val[i] = Math.round(val[i]);
        return val;
      };
    })(func);
  }
  var Converter = function() {
    this.convs = {};
  };
  Converter.prototype.routeSpace = function(space, args) {
    var values = args[0];
    if (values === undefined) {
      return this.getValues(space);
    }
    if (typeof values == "number") {
      values = Array.prototype.slice.call(args);
    }
    return this.setValues(space, values);
  };
  Converter.prototype.setValues = function(space, values) {
    this.space = space;
    this.convs = {};
    this.convs[space] = values;
    return this;
  };
  Converter.prototype.getValues = function(space) {
    var vals = this.convs[space];
    if (!vals) {
      var fspace = this.space,
          from = this.convs[fspace];
      vals = convert[fspace][space](from);
      this.convs[space] = vals;
    }
    return vals;
  };
  ["rgb", "hsl", "hsv", "cmyk", "keyword"].forEach(function(space) {
    Converter.prototype[space] = function(vals) {
      return this.routeSpace(space, arguments);
    };
  });
  module.exports = convert;
  global.define = __define;
  return module.exports;
});



System.register("npm:color-name@1.0.0", ["npm:color-name@1.0.0/index.json!github:systemjs/plugin-json@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:color-name@1.0.0/index.json!github:systemjs/plugin-json@0.1.0");
  global.define = __define;
  return module.exports;
});



System.register("npm:immutable@3.7.2", ["npm:immutable@3.7.2/dist/immutable"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:immutable@3.7.2/dist/immutable");
  global.define = __define;
  return module.exports;
});



System.register("npm:flux@2.0.3/lib/Dispatcher", ["npm:flux@2.0.3/lib/invariant"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var invariant = require("npm:flux@2.0.3/lib/invariant");
  var _lastID = 1;
  var _prefix = 'ID_';
  function Dispatcher() {
    this.$Dispatcher_callbacks = {};
    this.$Dispatcher_isPending = {};
    this.$Dispatcher_isHandled = {};
    this.$Dispatcher_isDispatching = false;
    this.$Dispatcher_pendingPayload = null;
  }
  Dispatcher.prototype.register = function(callback) {
    var id = _prefix + _lastID++;
    this.$Dispatcher_callbacks[id] = callback;
    return id;
  };
  Dispatcher.prototype.unregister = function(id) {
    invariant(this.$Dispatcher_callbacks[id], 'Dispatcher.unregister(...): `%s` does not map to a registered callback.', id);
    delete this.$Dispatcher_callbacks[id];
  };
  Dispatcher.prototype.waitFor = function(ids) {
    invariant(this.$Dispatcher_isDispatching, 'Dispatcher.waitFor(...): Must be invoked while dispatching.');
    for (var ii = 0; ii < ids.length; ii++) {
      var id = ids[ii];
      if (this.$Dispatcher_isPending[id]) {
        invariant(this.$Dispatcher_isHandled[id], 'Dispatcher.waitFor(...): Circular dependency detected while ' + 'waiting for `%s`.', id);
        continue;
      }
      invariant(this.$Dispatcher_callbacks[id], 'Dispatcher.waitFor(...): `%s` does not map to a registered callback.', id);
      this.$Dispatcher_invokeCallback(id);
    }
  };
  Dispatcher.prototype.dispatch = function(payload) {
    invariant(!this.$Dispatcher_isDispatching, 'Dispatch.dispatch(...): Cannot dispatch in the middle of a dispatch.');
    this.$Dispatcher_startDispatching(payload);
    try {
      for (var id in this.$Dispatcher_callbacks) {
        if (this.$Dispatcher_isPending[id]) {
          continue;
        }
        this.$Dispatcher_invokeCallback(id);
      }
    } finally {
      this.$Dispatcher_stopDispatching();
    }
  };
  Dispatcher.prototype.isDispatching = function() {
    return this.$Dispatcher_isDispatching;
  };
  Dispatcher.prototype.$Dispatcher_invokeCallback = function(id) {
    this.$Dispatcher_isPending[id] = true;
    this.$Dispatcher_callbacks[id](this.$Dispatcher_pendingPayload);
    this.$Dispatcher_isHandled[id] = true;
  };
  Dispatcher.prototype.$Dispatcher_startDispatching = function(payload) {
    for (var id in this.$Dispatcher_callbacks) {
      this.$Dispatcher_isPending[id] = false;
      this.$Dispatcher_isHandled[id] = false;
    }
    this.$Dispatcher_pendingPayload = payload;
    this.$Dispatcher_isDispatching = true;
  };
  Dispatcher.prototype.$Dispatcher_stopDispatching = function() {
    this.$Dispatcher_pendingPayload = null;
    this.$Dispatcher_isDispatching = false;
  };
  module.exports = Dispatcher;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/isArrayLike", ["npm:lodash@3.9.1/internal/getLength", "npm:lodash@3.9.1/internal/isLength"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var getLength = require("npm:lodash@3.9.1/internal/getLength"),
      isLength = require("npm:lodash@3.9.1/internal/isLength");
  function isArrayLike(value) {
    return value != null && isLength(getLength(value));
  }
  module.exports = isArrayLike;
  global.define = __define;
  return module.exports;
});



System.register("github:jspm/nodelibs-process@0.1.1/index", ["npm:process@0.10.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = System._nodeRequire ? process : require("npm:process@0.10.1");
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/createBaseFor", ["npm:lodash@3.9.1/internal/toObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var toObject = require("npm:lodash@3.9.1/internal/toObject");
  function createBaseFor(fromRight) {
    return function(object, iteratee, keysFunc) {
      var iterable = toObject(object),
          props = keysFunc(object),
          length = props.length,
          index = fromRight ? length : -1;
      while ((fromRight ? index-- : ++index < length)) {
        var key = props[index];
        if (iteratee(iterable[key], key, iterable) === false) {
          break;
        }
      }
      return object;
    };
  }
  module.exports = createBaseFor;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/createAssigner", ["npm:lodash@3.9.1/internal/bindCallback", "npm:lodash@3.9.1/internal/isIterateeCall", "npm:lodash@3.9.1/function/restParam"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var bindCallback = require("npm:lodash@3.9.1/internal/bindCallback"),
      isIterateeCall = require("npm:lodash@3.9.1/internal/isIterateeCall"),
      restParam = require("npm:lodash@3.9.1/function/restParam");
  function createAssigner(assigner) {
    return restParam(function(object, sources) {
      var index = -1,
          length = object == null ? 0 : sources.length,
          customizer = length > 2 ? sources[length - 2] : undefined,
          guard = length > 2 ? sources[2] : undefined,
          thisArg = length > 1 ? sources[length - 1] : undefined;
      if (typeof customizer == 'function') {
        customizer = bindCallback(customizer, thisArg, 5);
        length -= 2;
      } else {
        customizer = typeof thisArg == 'function' ? thisArg : undefined;
        length -= (customizer ? 1 : 0);
      }
      if (guard && isIterateeCall(sources[0], sources[1], guard)) {
        customizer = length < 3 ? undefined : customizer;
        length = 1;
      }
      while (++index < length) {
        var source = sources[index];
        if (source) {
          assigner(object, source, customizer);
        }
      }
      return object;
    });
  }
  module.exports = createAssigner;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/EventConstants", ["npm:react@0.13.3/lib/keyMirror"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var keyMirror = require("npm:react@0.13.3/lib/keyMirror");
  var PropagationPhases = keyMirror({
    bubbled: null,
    captured: null
  });
  var topLevelTypes = keyMirror({
    topBlur: null,
    topChange: null,
    topClick: null,
    topCompositionEnd: null,
    topCompositionStart: null,
    topCompositionUpdate: null,
    topContextMenu: null,
    topCopy: null,
    topCut: null,
    topDoubleClick: null,
    topDrag: null,
    topDragEnd: null,
    topDragEnter: null,
    topDragExit: null,
    topDragLeave: null,
    topDragOver: null,
    topDragStart: null,
    topDrop: null,
    topError: null,
    topFocus: null,
    topInput: null,
    topKeyDown: null,
    topKeyPress: null,
    topKeyUp: null,
    topLoad: null,
    topMouseDown: null,
    topMouseMove: null,
    topMouseOut: null,
    topMouseOver: null,
    topMouseUp: null,
    topPaste: null,
    topReset: null,
    topScroll: null,
    topSelectionChange: null,
    topSubmit: null,
    topTextInput: null,
    topTouchCancel: null,
    topTouchEnd: null,
    topTouchMove: null,
    topTouchStart: null,
    topWheel: null
  });
  var EventConstants = {
    topLevelTypes: topLevelTypes,
    PropagationPhases: PropagationPhases
  };
  module.exports = EventConstants;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactContext", ["npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/emptyObject", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var emptyObject = require("npm:react@0.13.3/lib/emptyObject");
    var warning = require("npm:react@0.13.3/lib/warning");
    var didWarn = false;
    var ReactContext = {
      current: emptyObject,
      withContext: function(newContext, scopedCallback) {
        if ("production" !== process.env.NODE_ENV) {
          ("production" !== process.env.NODE_ENV ? warning(didWarn, 'withContext is deprecated and will be removed in a future version. ' + 'Use a wrapper component with getChildContext instead.') : null);
          didWarn = true;
        }
        var result;
        var previousContext = ReactContext.current;
        ReactContext.current = assign({}, previousContext, newContext);
        try {
          result = scopedCallback();
        } finally {
          ReactContext.current = previousContext;
        }
        return result;
      }
    };
    module.exports = ReactContext;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/traverseAllChildren", ["npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactFragment", "npm:react@0.13.3/lib/ReactInstanceHandles", "npm:react@0.13.3/lib/getIteratorFn", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactFragment = require("npm:react@0.13.3/lib/ReactFragment");
    var ReactInstanceHandles = require("npm:react@0.13.3/lib/ReactInstanceHandles");
    var getIteratorFn = require("npm:react@0.13.3/lib/getIteratorFn");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var warning = require("npm:react@0.13.3/lib/warning");
    var SEPARATOR = ReactInstanceHandles.SEPARATOR;
    var SUBSEPARATOR = ':';
    var userProvidedKeyEscaperLookup = {
      '=': '=0',
      '.': '=1',
      ':': '=2'
    };
    var userProvidedKeyEscapeRegex = /[=.:]/g;
    var didWarnAboutMaps = false;
    function userProvidedKeyEscaper(match) {
      return userProvidedKeyEscaperLookup[match];
    }
    function getComponentKey(component, index) {
      if (component && component.key != null) {
        return wrapUserProvidedKey(component.key);
      }
      return index.toString(36);
    }
    function escapeUserProvidedKey(text) {
      return ('' + text).replace(userProvidedKeyEscapeRegex, userProvidedKeyEscaper);
    }
    function wrapUserProvidedKey(key) {
      return '$' + escapeUserProvidedKey(key);
    }
    function traverseAllChildrenImpl(children, nameSoFar, indexSoFar, callback, traverseContext) {
      var type = typeof children;
      if (type === 'undefined' || type === 'boolean') {
        children = null;
      }
      if (children === null || type === 'string' || type === 'number' || ReactElement.isValidElement(children)) {
        callback(traverseContext, children, nameSoFar === '' ? SEPARATOR + getComponentKey(children, 0) : nameSoFar, indexSoFar);
        return 1;
      }
      var child,
          nextName,
          nextIndex;
      var subtreeCount = 0;
      if (Array.isArray(children)) {
        for (var i = 0; i < children.length; i++) {
          child = children[i];
          nextName = ((nameSoFar !== '' ? nameSoFar + SUBSEPARATOR : SEPARATOR) + getComponentKey(child, i));
          nextIndex = indexSoFar + subtreeCount;
          subtreeCount += traverseAllChildrenImpl(child, nextName, nextIndex, callback, traverseContext);
        }
      } else {
        var iteratorFn = getIteratorFn(children);
        if (iteratorFn) {
          var iterator = iteratorFn.call(children);
          var step;
          if (iteratorFn !== children.entries) {
            var ii = 0;
            while (!(step = iterator.next()).done) {
              child = step.value;
              nextName = ((nameSoFar !== '' ? nameSoFar + SUBSEPARATOR : SEPARATOR) + getComponentKey(child, ii++));
              nextIndex = indexSoFar + subtreeCount;
              subtreeCount += traverseAllChildrenImpl(child, nextName, nextIndex, callback, traverseContext);
            }
          } else {
            if ("production" !== process.env.NODE_ENV) {
              ("production" !== process.env.NODE_ENV ? warning(didWarnAboutMaps, 'Using Maps as children is not yet fully supported. It is an ' + 'experimental feature that might be removed. Convert it to a ' + 'sequence / iterable of keyed ReactElements instead.') : null);
              didWarnAboutMaps = true;
            }
            while (!(step = iterator.next()).done) {
              var entry = step.value;
              if (entry) {
                child = entry[1];
                nextName = ((nameSoFar !== '' ? nameSoFar + SUBSEPARATOR : SEPARATOR) + wrapUserProvidedKey(entry[0]) + SUBSEPARATOR + getComponentKey(child, 0));
                nextIndex = indexSoFar + subtreeCount;
                subtreeCount += traverseAllChildrenImpl(child, nextName, nextIndex, callback, traverseContext);
              }
            }
          }
        } else if (type === 'object') {
          ("production" !== process.env.NODE_ENV ? invariant(children.nodeType !== 1, 'traverseAllChildren(...): Encountered an invalid child; DOM ' + 'elements are not valid children of React components.') : invariant(children.nodeType !== 1));
          var fragment = ReactFragment.extract(children);
          for (var key in fragment) {
            if (fragment.hasOwnProperty(key)) {
              child = fragment[key];
              nextName = ((nameSoFar !== '' ? nameSoFar + SUBSEPARATOR : SEPARATOR) + wrapUserProvidedKey(key) + SUBSEPARATOR + getComponentKey(child, 0));
              nextIndex = indexSoFar + subtreeCount;
              subtreeCount += traverseAllChildrenImpl(child, nextName, nextIndex, callback, traverseContext);
            }
          }
        }
      }
      return subtreeCount;
    }
    function traverseAllChildren(children, callback, traverseContext) {
      if (children == null) {
        return 0;
      }
      return traverseAllChildrenImpl(children, '', 0, callback, traverseContext);
    }
    module.exports = traverseAllChildren;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactReconciler", ["npm:react@0.13.3/lib/ReactRef", "npm:react@0.13.3/lib/ReactElementValidator", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactRef = require("npm:react@0.13.3/lib/ReactRef");
    var ReactElementValidator = require("npm:react@0.13.3/lib/ReactElementValidator");
    function attachRefs() {
      ReactRef.attachRefs(this, this._currentElement);
    }
    var ReactReconciler = {
      mountComponent: function(internalInstance, rootID, transaction, context) {
        var markup = internalInstance.mountComponent(rootID, transaction, context);
        if ("production" !== process.env.NODE_ENV) {
          ReactElementValidator.checkAndWarnForMutatedProps(internalInstance._currentElement);
        }
        transaction.getReactMountReady().enqueue(attachRefs, internalInstance);
        return markup;
      },
      unmountComponent: function(internalInstance) {
        ReactRef.detachRefs(internalInstance, internalInstance._currentElement);
        internalInstance.unmountComponent();
      },
      receiveComponent: function(internalInstance, nextElement, transaction, context) {
        var prevElement = internalInstance._currentElement;
        if (nextElement === prevElement && nextElement._owner != null) {
          return ;
        }
        if ("production" !== process.env.NODE_ENV) {
          ReactElementValidator.checkAndWarnForMutatedProps(nextElement);
        }
        var refsChanged = ReactRef.shouldUpdateRefs(prevElement, nextElement);
        if (refsChanged) {
          ReactRef.detachRefs(internalInstance, prevElement);
        }
        internalInstance.receiveComponent(nextElement, transaction, context);
        if (refsChanged) {
          transaction.getReactMountReady().enqueue(attachRefs, internalInstance);
        }
      },
      performUpdateIfNecessary: function(internalInstance, transaction) {
        internalInstance.performUpdateIfNecessary(transaction);
      }
    };
    module.exports = ReactReconciler;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/DOMPropertyOperations", ["npm:react@0.13.3/lib/DOMProperty", "npm:react@0.13.3/lib/quoteAttributeValueForBrowser", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var DOMProperty = require("npm:react@0.13.3/lib/DOMProperty");
    var quoteAttributeValueForBrowser = require("npm:react@0.13.3/lib/quoteAttributeValueForBrowser");
    var warning = require("npm:react@0.13.3/lib/warning");
    function shouldIgnoreValue(name, value) {
      return value == null || (DOMProperty.hasBooleanValue[name] && !value) || (DOMProperty.hasNumericValue[name] && isNaN(value)) || (DOMProperty.hasPositiveNumericValue[name] && (value < 1)) || (DOMProperty.hasOverloadedBooleanValue[name] && value === false);
    }
    if ("production" !== process.env.NODE_ENV) {
      var reactProps = {
        children: true,
        dangerouslySetInnerHTML: true,
        key: true,
        ref: true
      };
      var warnedProperties = {};
      var warnUnknownProperty = function(name) {
        if (reactProps.hasOwnProperty(name) && reactProps[name] || warnedProperties.hasOwnProperty(name) && warnedProperties[name]) {
          return ;
        }
        warnedProperties[name] = true;
        var lowerCasedName = name.toLowerCase();
        var standardName = (DOMProperty.isCustomAttribute(lowerCasedName) ? lowerCasedName : DOMProperty.getPossibleStandardName.hasOwnProperty(lowerCasedName) ? DOMProperty.getPossibleStandardName[lowerCasedName] : null);
        ("production" !== process.env.NODE_ENV ? warning(standardName == null, 'Unknown DOM property %s. Did you mean %s?', name, standardName) : null);
      };
    }
    var DOMPropertyOperations = {
      createMarkupForID: function(id) {
        return DOMProperty.ID_ATTRIBUTE_NAME + '=' + quoteAttributeValueForBrowser(id);
      },
      createMarkupForProperty: function(name, value) {
        if (DOMProperty.isStandardName.hasOwnProperty(name) && DOMProperty.isStandardName[name]) {
          if (shouldIgnoreValue(name, value)) {
            return '';
          }
          var attributeName = DOMProperty.getAttributeName[name];
          if (DOMProperty.hasBooleanValue[name] || (DOMProperty.hasOverloadedBooleanValue[name] && value === true)) {
            return attributeName;
          }
          return attributeName + '=' + quoteAttributeValueForBrowser(value);
        } else if (DOMProperty.isCustomAttribute(name)) {
          if (value == null) {
            return '';
          }
          return name + '=' + quoteAttributeValueForBrowser(value);
        } else if ("production" !== process.env.NODE_ENV) {
          warnUnknownProperty(name);
        }
        return null;
      },
      setValueForProperty: function(node, name, value) {
        if (DOMProperty.isStandardName.hasOwnProperty(name) && DOMProperty.isStandardName[name]) {
          var mutationMethod = DOMProperty.getMutationMethod[name];
          if (mutationMethod) {
            mutationMethod(node, value);
          } else if (shouldIgnoreValue(name, value)) {
            this.deleteValueForProperty(node, name);
          } else if (DOMProperty.mustUseAttribute[name]) {
            node.setAttribute(DOMProperty.getAttributeName[name], '' + value);
          } else {
            var propName = DOMProperty.getPropertyName[name];
            if (!DOMProperty.hasSideEffects[name] || ('' + node[propName]) !== ('' + value)) {
              node[propName] = value;
            }
          }
        } else if (DOMProperty.isCustomAttribute(name)) {
          if (value == null) {
            node.removeAttribute(name);
          } else {
            node.setAttribute(name, '' + value);
          }
        } else if ("production" !== process.env.NODE_ENV) {
          warnUnknownProperty(name);
        }
      },
      deleteValueForProperty: function(node, name) {
        if (DOMProperty.isStandardName.hasOwnProperty(name) && DOMProperty.isStandardName[name]) {
          var mutationMethod = DOMProperty.getMutationMethod[name];
          if (mutationMethod) {
            mutationMethod(node, undefined);
          } else if (DOMProperty.mustUseAttribute[name]) {
            node.removeAttribute(DOMProperty.getAttributeName[name]);
          } else {
            var propName = DOMProperty.getPropertyName[name];
            var defaultValue = DOMProperty.getDefaultValueForProperty(node.nodeName, propName);
            if (!DOMProperty.hasSideEffects[name] || ('' + node[propName]) !== defaultValue) {
              node[propName] = defaultValue;
            }
          }
        } else if (DOMProperty.isCustomAttribute(name)) {
          node.removeAttribute(name);
        } else if ("production" !== process.env.NODE_ENV) {
          warnUnknownProperty(name);
        }
      }
    };
    module.exports = DOMPropertyOperations;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/CSSPropertyOperations", ["npm:react@0.13.3/lib/CSSProperty", "npm:react@0.13.3/lib/ExecutionEnvironment", "npm:react@0.13.3/lib/camelizeStyleName", "npm:react@0.13.3/lib/dangerousStyleValue", "npm:react@0.13.3/lib/hyphenateStyleName", "npm:react@0.13.3/lib/memoizeStringOnly", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var CSSProperty = require("npm:react@0.13.3/lib/CSSProperty");
    var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
    var camelizeStyleName = require("npm:react@0.13.3/lib/camelizeStyleName");
    var dangerousStyleValue = require("npm:react@0.13.3/lib/dangerousStyleValue");
    var hyphenateStyleName = require("npm:react@0.13.3/lib/hyphenateStyleName");
    var memoizeStringOnly = require("npm:react@0.13.3/lib/memoizeStringOnly");
    var warning = require("npm:react@0.13.3/lib/warning");
    var processStyleName = memoizeStringOnly(function(styleName) {
      return hyphenateStyleName(styleName);
    });
    var styleFloatAccessor = 'cssFloat';
    if (ExecutionEnvironment.canUseDOM) {
      if (document.documentElement.style.cssFloat === undefined) {
        styleFloatAccessor = 'styleFloat';
      }
    }
    if ("production" !== process.env.NODE_ENV) {
      var badVendoredStyleNamePattern = /^(?:webkit|moz|o)[A-Z]/;
      var badStyleValueWithSemicolonPattern = /;\s*$/;
      var warnedStyleNames = {};
      var warnedStyleValues = {};
      var warnHyphenatedStyleName = function(name) {
        if (warnedStyleNames.hasOwnProperty(name) && warnedStyleNames[name]) {
          return ;
        }
        warnedStyleNames[name] = true;
        ("production" !== process.env.NODE_ENV ? warning(false, 'Unsupported style property %s. Did you mean %s?', name, camelizeStyleName(name)) : null);
      };
      var warnBadVendoredStyleName = function(name) {
        if (warnedStyleNames.hasOwnProperty(name) && warnedStyleNames[name]) {
          return ;
        }
        warnedStyleNames[name] = true;
        ("production" !== process.env.NODE_ENV ? warning(false, 'Unsupported vendor-prefixed style property %s. Did you mean %s?', name, name.charAt(0).toUpperCase() + name.slice(1)) : null);
      };
      var warnStyleValueWithSemicolon = function(name, value) {
        if (warnedStyleValues.hasOwnProperty(value) && warnedStyleValues[value]) {
          return ;
        }
        warnedStyleValues[value] = true;
        ("production" !== process.env.NODE_ENV ? warning(false, 'Style property values shouldn\'t contain a semicolon. ' + 'Try "%s: %s" instead.', name, value.replace(badStyleValueWithSemicolonPattern, '')) : null);
      };
      var warnValidStyle = function(name, value) {
        if (name.indexOf('-') > -1) {
          warnHyphenatedStyleName(name);
        } else if (badVendoredStyleNamePattern.test(name)) {
          warnBadVendoredStyleName(name);
        } else if (badStyleValueWithSemicolonPattern.test(value)) {
          warnStyleValueWithSemicolon(name, value);
        }
      };
    }
    var CSSPropertyOperations = {
      createMarkupForStyles: function(styles) {
        var serialized = '';
        for (var styleName in styles) {
          if (!styles.hasOwnProperty(styleName)) {
            continue;
          }
          var styleValue = styles[styleName];
          if ("production" !== process.env.NODE_ENV) {
            warnValidStyle(styleName, styleValue);
          }
          if (styleValue != null) {
            serialized += processStyleName(styleName) + ':';
            serialized += dangerousStyleValue(styleName, styleValue) + ';';
          }
        }
        return serialized || null;
      },
      setValueForStyles: function(node, styles) {
        var style = node.style;
        for (var styleName in styles) {
          if (!styles.hasOwnProperty(styleName)) {
            continue;
          }
          if ("production" !== process.env.NODE_ENV) {
            warnValidStyle(styleName, styles[styleName]);
          }
          var styleValue = dangerousStyleValue(styleName, styles[styleName]);
          if (styleName === 'float') {
            styleName = styleFloatAccessor;
          }
          if (styleValue) {
            style[styleName] = styleValue;
          } else {
            var expansion = CSSProperty.shorthandPropertyExpansions[styleName];
            if (expansion) {
              for (var individualStyleName in expansion) {
                style[individualStyleName] = '';
              }
            } else {
              style[styleName] = '';
            }
          }
        }
      }
    };
    module.exports = CSSPropertyOperations;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/createNodesFromMarkup", ["npm:react@0.13.3/lib/ExecutionEnvironment", "npm:react@0.13.3/lib/createArrayFromMixed", "npm:react@0.13.3/lib/getMarkupWrap", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
    var createArrayFromMixed = require("npm:react@0.13.3/lib/createArrayFromMixed");
    var getMarkupWrap = require("npm:react@0.13.3/lib/getMarkupWrap");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var dummyNode = ExecutionEnvironment.canUseDOM ? document.createElement('div') : null;
    var nodeNamePattern = /^\s*<(\w+)/;
    function getNodeName(markup) {
      var nodeNameMatch = markup.match(nodeNamePattern);
      return nodeNameMatch && nodeNameMatch[1].toLowerCase();
    }
    function createNodesFromMarkup(markup, handleScript) {
      var node = dummyNode;
      ("production" !== process.env.NODE_ENV ? invariant(!!dummyNode, 'createNodesFromMarkup dummy not initialized') : invariant(!!dummyNode));
      var nodeName = getNodeName(markup);
      var wrap = nodeName && getMarkupWrap(nodeName);
      if (wrap) {
        node.innerHTML = wrap[1] + markup + wrap[2];
        var wrapDepth = wrap[0];
        while (wrapDepth--) {
          node = node.lastChild;
        }
      } else {
        node.innerHTML = markup;
      }
      var scripts = node.getElementsByTagName('script');
      if (scripts.length) {
        ("production" !== process.env.NODE_ENV ? invariant(handleScript, 'createNodesFromMarkup(...): Unexpected <script> element rendered.') : invariant(handleScript));
        createArrayFromMixed(scripts).forEach(handleScript);
      }
      var nodes = createArrayFromMixed(node.childNodes);
      while (node.lastChild) {
        node.removeChild(node.lastChild);
      }
      return nodes;
    }
    module.exports = createNodesFromMarkup;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactBrowserEventEmitter", ["npm:react@0.13.3/lib/EventConstants", "npm:react@0.13.3/lib/EventPluginHub", "npm:react@0.13.3/lib/EventPluginRegistry", "npm:react@0.13.3/lib/ReactEventEmitterMixin", "npm:react@0.13.3/lib/ViewportMetrics", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/isEventSupported", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var EventConstants = require("npm:react@0.13.3/lib/EventConstants");
    var EventPluginHub = require("npm:react@0.13.3/lib/EventPluginHub");
    var EventPluginRegistry = require("npm:react@0.13.3/lib/EventPluginRegistry");
    var ReactEventEmitterMixin = require("npm:react@0.13.3/lib/ReactEventEmitterMixin");
    var ViewportMetrics = require("npm:react@0.13.3/lib/ViewportMetrics");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var isEventSupported = require("npm:react@0.13.3/lib/isEventSupported");
    var alreadyListeningTo = {};
    var isMonitoringScrollValue = false;
    var reactTopListenersCounter = 0;
    var topEventMapping = {
      topBlur: 'blur',
      topChange: 'change',
      topClick: 'click',
      topCompositionEnd: 'compositionend',
      topCompositionStart: 'compositionstart',
      topCompositionUpdate: 'compositionupdate',
      topContextMenu: 'contextmenu',
      topCopy: 'copy',
      topCut: 'cut',
      topDoubleClick: 'dblclick',
      topDrag: 'drag',
      topDragEnd: 'dragend',
      topDragEnter: 'dragenter',
      topDragExit: 'dragexit',
      topDragLeave: 'dragleave',
      topDragOver: 'dragover',
      topDragStart: 'dragstart',
      topDrop: 'drop',
      topFocus: 'focus',
      topInput: 'input',
      topKeyDown: 'keydown',
      topKeyPress: 'keypress',
      topKeyUp: 'keyup',
      topMouseDown: 'mousedown',
      topMouseMove: 'mousemove',
      topMouseOut: 'mouseout',
      topMouseOver: 'mouseover',
      topMouseUp: 'mouseup',
      topPaste: 'paste',
      topScroll: 'scroll',
      topSelectionChange: 'selectionchange',
      topTextInput: 'textInput',
      topTouchCancel: 'touchcancel',
      topTouchEnd: 'touchend',
      topTouchMove: 'touchmove',
      topTouchStart: 'touchstart',
      topWheel: 'wheel'
    };
    var topListenersIDKey = '_reactListenersID' + String(Math.random()).slice(2);
    function getListeningForDocument(mountAt) {
      if (!Object.prototype.hasOwnProperty.call(mountAt, topListenersIDKey)) {
        mountAt[topListenersIDKey] = reactTopListenersCounter++;
        alreadyListeningTo[mountAt[topListenersIDKey]] = {};
      }
      return alreadyListeningTo[mountAt[topListenersIDKey]];
    }
    var ReactBrowserEventEmitter = assign({}, ReactEventEmitterMixin, {
      ReactEventListener: null,
      injection: {injectReactEventListener: function(ReactEventListener) {
          ReactEventListener.setHandleTopLevel(ReactBrowserEventEmitter.handleTopLevel);
          ReactBrowserEventEmitter.ReactEventListener = ReactEventListener;
        }},
      setEnabled: function(enabled) {
        if (ReactBrowserEventEmitter.ReactEventListener) {
          ReactBrowserEventEmitter.ReactEventListener.setEnabled(enabled);
        }
      },
      isEnabled: function() {
        return !!((ReactBrowserEventEmitter.ReactEventListener && ReactBrowserEventEmitter.ReactEventListener.isEnabled()));
      },
      listenTo: function(registrationName, contentDocumentHandle) {
        var mountAt = contentDocumentHandle;
        var isListening = getListeningForDocument(mountAt);
        var dependencies = EventPluginRegistry.registrationNameDependencies[registrationName];
        var topLevelTypes = EventConstants.topLevelTypes;
        for (var i = 0,
            l = dependencies.length; i < l; i++) {
          var dependency = dependencies[i];
          if (!((isListening.hasOwnProperty(dependency) && isListening[dependency]))) {
            if (dependency === topLevelTypes.topWheel) {
              if (isEventSupported('wheel')) {
                ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(topLevelTypes.topWheel, 'wheel', mountAt);
              } else if (isEventSupported('mousewheel')) {
                ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(topLevelTypes.topWheel, 'mousewheel', mountAt);
              } else {
                ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(topLevelTypes.topWheel, 'DOMMouseScroll', mountAt);
              }
            } else if (dependency === topLevelTypes.topScroll) {
              if (isEventSupported('scroll', true)) {
                ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(topLevelTypes.topScroll, 'scroll', mountAt);
              } else {
                ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(topLevelTypes.topScroll, 'scroll', ReactBrowserEventEmitter.ReactEventListener.WINDOW_HANDLE);
              }
            } else if (dependency === topLevelTypes.topFocus || dependency === topLevelTypes.topBlur) {
              if (isEventSupported('focus', true)) {
                ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(topLevelTypes.topFocus, 'focus', mountAt);
                ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(topLevelTypes.topBlur, 'blur', mountAt);
              } else if (isEventSupported('focusin')) {
                ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(topLevelTypes.topFocus, 'focusin', mountAt);
                ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(topLevelTypes.topBlur, 'focusout', mountAt);
              }
              isListening[topLevelTypes.topBlur] = true;
              isListening[topLevelTypes.topFocus] = true;
            } else if (topEventMapping.hasOwnProperty(dependency)) {
              ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(dependency, topEventMapping[dependency], mountAt);
            }
            isListening[dependency] = true;
          }
        }
      },
      trapBubbledEvent: function(topLevelType, handlerBaseName, handle) {
        return ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(topLevelType, handlerBaseName, handle);
      },
      trapCapturedEvent: function(topLevelType, handlerBaseName, handle) {
        return ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(topLevelType, handlerBaseName, handle);
      },
      ensureScrollValueMonitoring: function() {
        if (!isMonitoringScrollValue) {
          var refresh = ViewportMetrics.refreshScrollValues;
          ReactBrowserEventEmitter.ReactEventListener.monitorScrollValue(refresh);
          isMonitoringScrollValue = true;
        }
      },
      eventNameDispatchConfigs: EventPluginHub.eventNameDispatchConfigs,
      registrationNameModules: EventPluginHub.registrationNameModules,
      putListener: EventPluginHub.putListener,
      getListener: EventPluginHub.getListener,
      deleteListener: EventPluginHub.deleteListener,
      deleteAllListeners: EventPluginHub.deleteAllListeners
    });
    module.exports = ReactBrowserEventEmitter;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/containsNode", ["npm:react@0.13.3/lib/isTextNode"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isTextNode = require("npm:react@0.13.3/lib/isTextNode");
  function containsNode(outerNode, innerNode) {
    if (!outerNode || !innerNode) {
      return false;
    } else if (outerNode === innerNode) {
      return true;
    } else if (isTextNode(outerNode)) {
      return false;
    } else if (isTextNode(innerNode)) {
      return containsNode(outerNode, innerNode.parentNode);
    } else if (outerNode.contains) {
      return outerNode.contains(innerNode);
    } else if (outerNode.compareDocumentPosition) {
      return !!(outerNode.compareDocumentPosition(innerNode) & 16);
    } else {
      return false;
    }
  }
  module.exports = containsNode;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/instantiateReactComponent", ["npm:react@0.13.3/lib/ReactCompositeComponent", "npm:react@0.13.3/lib/ReactEmptyComponent", "npm:react@0.13.3/lib/ReactNativeComponent", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactCompositeComponent = require("npm:react@0.13.3/lib/ReactCompositeComponent");
    var ReactEmptyComponent = require("npm:react@0.13.3/lib/ReactEmptyComponent");
    var ReactNativeComponent = require("npm:react@0.13.3/lib/ReactNativeComponent");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var warning = require("npm:react@0.13.3/lib/warning");
    var ReactCompositeComponentWrapper = function() {};
    assign(ReactCompositeComponentWrapper.prototype, ReactCompositeComponent.Mixin, {_instantiateReactComponent: instantiateReactComponent});
    function isInternalComponentType(type) {
      return (typeof type === 'function' && typeof type.prototype !== 'undefined' && typeof type.prototype.mountComponent === 'function' && typeof type.prototype.receiveComponent === 'function');
    }
    function instantiateReactComponent(node, parentCompositeType) {
      var instance;
      if (node === null || node === false) {
        node = ReactEmptyComponent.emptyElement;
      }
      if (typeof node === 'object') {
        var element = node;
        if ("production" !== process.env.NODE_ENV) {
          ("production" !== process.env.NODE_ENV ? warning(element && (typeof element.type === 'function' || typeof element.type === 'string'), 'Only functions or strings can be mounted as React components.') : null);
        }
        if (parentCompositeType === element.type && typeof element.type === 'string') {
          instance = ReactNativeComponent.createInternalComponent(element);
        } else if (isInternalComponentType(element.type)) {
          instance = new element.type(element);
        } else {
          instance = new ReactCompositeComponentWrapper();
        }
      } else if (typeof node === 'string' || typeof node === 'number') {
        instance = ReactNativeComponent.createInstanceForText(node);
      } else {
        ("production" !== process.env.NODE_ENV ? invariant(false, 'Encountered invalid React node of type %s', typeof node) : invariant(false));
      }
      if ("production" !== process.env.NODE_ENV) {
        ("production" !== process.env.NODE_ENV ? warning(typeof instance.construct === 'function' && typeof instance.mountComponent === 'function' && typeof instance.receiveComponent === 'function' && typeof instance.unmountComponent === 'function', 'Only React Components can be mounted.') : null);
      }
      instance.construct(node);
      instance._mountIndex = 0;
      instance._mountImage = null;
      if ("production" !== process.env.NODE_ENV) {
        instance._isOwnerNecessary = false;
        instance._warnedAboutRefsInRender = false;
      }
      if ("production" !== process.env.NODE_ENV) {
        if (Object.preventExtensions) {
          Object.preventExtensions(instance);
        }
      }
      return instance;
    }
    module.exports = instantiateReactComponent;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactMultiChild", ["npm:react@0.13.3/lib/ReactComponentEnvironment", "npm:react@0.13.3/lib/ReactMultiChildUpdateTypes", "npm:react@0.13.3/lib/ReactReconciler", "npm:react@0.13.3/lib/ReactChildReconciler", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactComponentEnvironment = require("npm:react@0.13.3/lib/ReactComponentEnvironment");
    var ReactMultiChildUpdateTypes = require("npm:react@0.13.3/lib/ReactMultiChildUpdateTypes");
    var ReactReconciler = require("npm:react@0.13.3/lib/ReactReconciler");
    var ReactChildReconciler = require("npm:react@0.13.3/lib/ReactChildReconciler");
    var updateDepth = 0;
    var updateQueue = [];
    var markupQueue = [];
    function enqueueMarkup(parentID, markup, toIndex) {
      updateQueue.push({
        parentID: parentID,
        parentNode: null,
        type: ReactMultiChildUpdateTypes.INSERT_MARKUP,
        markupIndex: markupQueue.push(markup) - 1,
        textContent: null,
        fromIndex: null,
        toIndex: toIndex
      });
    }
    function enqueueMove(parentID, fromIndex, toIndex) {
      updateQueue.push({
        parentID: parentID,
        parentNode: null,
        type: ReactMultiChildUpdateTypes.MOVE_EXISTING,
        markupIndex: null,
        textContent: null,
        fromIndex: fromIndex,
        toIndex: toIndex
      });
    }
    function enqueueRemove(parentID, fromIndex) {
      updateQueue.push({
        parentID: parentID,
        parentNode: null,
        type: ReactMultiChildUpdateTypes.REMOVE_NODE,
        markupIndex: null,
        textContent: null,
        fromIndex: fromIndex,
        toIndex: null
      });
    }
    function enqueueTextContent(parentID, textContent) {
      updateQueue.push({
        parentID: parentID,
        parentNode: null,
        type: ReactMultiChildUpdateTypes.TEXT_CONTENT,
        markupIndex: null,
        textContent: textContent,
        fromIndex: null,
        toIndex: null
      });
    }
    function processQueue() {
      if (updateQueue.length) {
        ReactComponentEnvironment.processChildrenUpdates(updateQueue, markupQueue);
        clearQueue();
      }
    }
    function clearQueue() {
      updateQueue.length = 0;
      markupQueue.length = 0;
    }
    var ReactMultiChild = {Mixin: {
        mountChildren: function(nestedChildren, transaction, context) {
          var children = ReactChildReconciler.instantiateChildren(nestedChildren, transaction, context);
          this._renderedChildren = children;
          var mountImages = [];
          var index = 0;
          for (var name in children) {
            if (children.hasOwnProperty(name)) {
              var child = children[name];
              var rootID = this._rootNodeID + name;
              var mountImage = ReactReconciler.mountComponent(child, rootID, transaction, context);
              child._mountIndex = index;
              mountImages.push(mountImage);
              index++;
            }
          }
          return mountImages;
        },
        updateTextContent: function(nextContent) {
          updateDepth++;
          var errorThrown = true;
          try {
            var prevChildren = this._renderedChildren;
            ReactChildReconciler.unmountChildren(prevChildren);
            for (var name in prevChildren) {
              if (prevChildren.hasOwnProperty(name)) {
                this._unmountChildByName(prevChildren[name], name);
              }
            }
            this.setTextContent(nextContent);
            errorThrown = false;
          } finally {
            updateDepth--;
            if (!updateDepth) {
              if (errorThrown) {
                clearQueue();
              } else {
                processQueue();
              }
            }
          }
        },
        updateChildren: function(nextNestedChildren, transaction, context) {
          updateDepth++;
          var errorThrown = true;
          try {
            this._updateChildren(nextNestedChildren, transaction, context);
            errorThrown = false;
          } finally {
            updateDepth--;
            if (!updateDepth) {
              if (errorThrown) {
                clearQueue();
              } else {
                processQueue();
              }
            }
          }
        },
        _updateChildren: function(nextNestedChildren, transaction, context) {
          var prevChildren = this._renderedChildren;
          var nextChildren = ReactChildReconciler.updateChildren(prevChildren, nextNestedChildren, transaction, context);
          this._renderedChildren = nextChildren;
          if (!nextChildren && !prevChildren) {
            return ;
          }
          var name;
          var lastIndex = 0;
          var nextIndex = 0;
          for (name in nextChildren) {
            if (!nextChildren.hasOwnProperty(name)) {
              continue;
            }
            var prevChild = prevChildren && prevChildren[name];
            var nextChild = nextChildren[name];
            if (prevChild === nextChild) {
              this.moveChild(prevChild, nextIndex, lastIndex);
              lastIndex = Math.max(prevChild._mountIndex, lastIndex);
              prevChild._mountIndex = nextIndex;
            } else {
              if (prevChild) {
                lastIndex = Math.max(prevChild._mountIndex, lastIndex);
                this._unmountChildByName(prevChild, name);
              }
              this._mountChildByNameAtIndex(nextChild, name, nextIndex, transaction, context);
            }
            nextIndex++;
          }
          for (name in prevChildren) {
            if (prevChildren.hasOwnProperty(name) && !(nextChildren && nextChildren.hasOwnProperty(name))) {
              this._unmountChildByName(prevChildren[name], name);
            }
          }
        },
        unmountChildren: function() {
          var renderedChildren = this._renderedChildren;
          ReactChildReconciler.unmountChildren(renderedChildren);
          this._renderedChildren = null;
        },
        moveChild: function(child, toIndex, lastIndex) {
          if (child._mountIndex < lastIndex) {
            enqueueMove(this._rootNodeID, child._mountIndex, toIndex);
          }
        },
        createChild: function(child, mountImage) {
          enqueueMarkup(this._rootNodeID, mountImage, child._mountIndex);
        },
        removeChild: function(child) {
          enqueueRemove(this._rootNodeID, child._mountIndex);
        },
        setTextContent: function(textContent) {
          enqueueTextContent(this._rootNodeID, textContent);
        },
        _mountChildByNameAtIndex: function(child, name, index, transaction, context) {
          var rootID = this._rootNodeID + name;
          var mountImage = ReactReconciler.mountComponent(child, rootID, transaction, context);
          child._mountIndex = index;
          this.createChild(child, mountImage);
        },
        _unmountChildByName: function(child, name) {
          this.removeChild(child);
          child._mountIndex = null;
        }
      }};
    module.exports = ReactMultiChild;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SyntheticCompositionEvent", ["npm:react@0.13.3/lib/SyntheticEvent"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var SyntheticEvent = require("npm:react@0.13.3/lib/SyntheticEvent");
  var CompositionEventInterface = {data: null};
  function SyntheticCompositionEvent(dispatchConfig, dispatchMarker, nativeEvent) {
    SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
  }
  SyntheticEvent.augmentClass(SyntheticCompositionEvent, CompositionEventInterface);
  module.exports = SyntheticCompositionEvent;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/EnterLeaveEventPlugin", ["npm:react@0.13.3/lib/EventConstants", "npm:react@0.13.3/lib/EventPropagators", "npm:react@0.13.3/lib/SyntheticMouseEvent", "npm:react@0.13.3/lib/ReactMount", "npm:react@0.13.3/lib/keyOf"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var EventConstants = require("npm:react@0.13.3/lib/EventConstants");
  var EventPropagators = require("npm:react@0.13.3/lib/EventPropagators");
  var SyntheticMouseEvent = require("npm:react@0.13.3/lib/SyntheticMouseEvent");
  var ReactMount = require("npm:react@0.13.3/lib/ReactMount");
  var keyOf = require("npm:react@0.13.3/lib/keyOf");
  var topLevelTypes = EventConstants.topLevelTypes;
  var getFirstReactDOM = ReactMount.getFirstReactDOM;
  var eventTypes = {
    mouseEnter: {
      registrationName: keyOf({onMouseEnter: null}),
      dependencies: [topLevelTypes.topMouseOut, topLevelTypes.topMouseOver]
    },
    mouseLeave: {
      registrationName: keyOf({onMouseLeave: null}),
      dependencies: [topLevelTypes.topMouseOut, topLevelTypes.topMouseOver]
    }
  };
  var extractedEvents = [null, null];
  var EnterLeaveEventPlugin = {
    eventTypes: eventTypes,
    extractEvents: function(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent) {
      if (topLevelType === topLevelTypes.topMouseOver && (nativeEvent.relatedTarget || nativeEvent.fromElement)) {
        return null;
      }
      if (topLevelType !== topLevelTypes.topMouseOut && topLevelType !== topLevelTypes.topMouseOver) {
        return null;
      }
      var win;
      if (topLevelTarget.window === topLevelTarget) {
        win = topLevelTarget;
      } else {
        var doc = topLevelTarget.ownerDocument;
        if (doc) {
          win = doc.defaultView || doc.parentWindow;
        } else {
          win = window;
        }
      }
      var from,
          to;
      if (topLevelType === topLevelTypes.topMouseOut) {
        from = topLevelTarget;
        to = getFirstReactDOM(nativeEvent.relatedTarget || nativeEvent.toElement) || win;
      } else {
        from = win;
        to = topLevelTarget;
      }
      if (from === to) {
        return null;
      }
      var fromID = from ? ReactMount.getID(from) : '';
      var toID = to ? ReactMount.getID(to) : '';
      var leave = SyntheticMouseEvent.getPooled(eventTypes.mouseLeave, fromID, nativeEvent);
      leave.type = 'mouseleave';
      leave.target = from;
      leave.relatedTarget = to;
      var enter = SyntheticMouseEvent.getPooled(eventTypes.mouseEnter, toID, nativeEvent);
      enter.type = 'mouseenter';
      enter.target = to;
      enter.relatedTarget = from;
      EventPropagators.accumulateEnterLeaveDispatches(leave, enter, fromID, toID);
      extractedEvents[0] = leave;
      extractedEvents[1] = enter;
      return extractedEvents;
    }
  };
  module.exports = EnterLeaveEventPlugin;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOMButton", ["npm:react@0.13.3/lib/AutoFocusMixin", "npm:react@0.13.3/lib/ReactBrowserComponentMixin", "npm:react@0.13.3/lib/ReactClass", "npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/keyMirror"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var AutoFocusMixin = require("npm:react@0.13.3/lib/AutoFocusMixin");
  var ReactBrowserComponentMixin = require("npm:react@0.13.3/lib/ReactBrowserComponentMixin");
  var ReactClass = require("npm:react@0.13.3/lib/ReactClass");
  var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
  var keyMirror = require("npm:react@0.13.3/lib/keyMirror");
  var button = ReactElement.createFactory('button');
  var mouseListenerNames = keyMirror({
    onClick: true,
    onDoubleClick: true,
    onMouseDown: true,
    onMouseMove: true,
    onMouseUp: true,
    onClickCapture: true,
    onDoubleClickCapture: true,
    onMouseDownCapture: true,
    onMouseMoveCapture: true,
    onMouseUpCapture: true
  });
  var ReactDOMButton = ReactClass.createClass({
    displayName: 'ReactDOMButton',
    tagName: 'BUTTON',
    mixins: [AutoFocusMixin, ReactBrowserComponentMixin],
    render: function() {
      var props = {};
      for (var key in this.props) {
        if (this.props.hasOwnProperty(key) && (!this.props.disabled || !mouseListenerNames[key])) {
          props[key] = this.props[key];
        }
      }
      return button(props, this.props.children);
    }
  });
  module.exports = ReactDOMButton;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOMInput", ["npm:react@0.13.3/lib/AutoFocusMixin", "npm:react@0.13.3/lib/DOMPropertyOperations", "npm:react@0.13.3/lib/LinkedValueUtils", "npm:react@0.13.3/lib/ReactBrowserComponentMixin", "npm:react@0.13.3/lib/ReactClass", "npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactMount", "npm:react@0.13.3/lib/ReactUpdates", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var AutoFocusMixin = require("npm:react@0.13.3/lib/AutoFocusMixin");
    var DOMPropertyOperations = require("npm:react@0.13.3/lib/DOMPropertyOperations");
    var LinkedValueUtils = require("npm:react@0.13.3/lib/LinkedValueUtils");
    var ReactBrowserComponentMixin = require("npm:react@0.13.3/lib/ReactBrowserComponentMixin");
    var ReactClass = require("npm:react@0.13.3/lib/ReactClass");
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactMount = require("npm:react@0.13.3/lib/ReactMount");
    var ReactUpdates = require("npm:react@0.13.3/lib/ReactUpdates");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var input = ReactElement.createFactory('input');
    var instancesByReactID = {};
    function forceUpdateIfMounted() {
      if (this.isMounted()) {
        this.forceUpdate();
      }
    }
    var ReactDOMInput = ReactClass.createClass({
      displayName: 'ReactDOMInput',
      tagName: 'INPUT',
      mixins: [AutoFocusMixin, LinkedValueUtils.Mixin, ReactBrowserComponentMixin],
      getInitialState: function() {
        var defaultValue = this.props.defaultValue;
        return {
          initialChecked: this.props.defaultChecked || false,
          initialValue: defaultValue != null ? defaultValue : null
        };
      },
      render: function() {
        var props = assign({}, this.props);
        props.defaultChecked = null;
        props.defaultValue = null;
        var value = LinkedValueUtils.getValue(this);
        props.value = value != null ? value : this.state.initialValue;
        var checked = LinkedValueUtils.getChecked(this);
        props.checked = checked != null ? checked : this.state.initialChecked;
        props.onChange = this._handleChange;
        return input(props, this.props.children);
      },
      componentDidMount: function() {
        var id = ReactMount.getID(this.getDOMNode());
        instancesByReactID[id] = this;
      },
      componentWillUnmount: function() {
        var rootNode = this.getDOMNode();
        var id = ReactMount.getID(rootNode);
        delete instancesByReactID[id];
      },
      componentDidUpdate: function(prevProps, prevState, prevContext) {
        var rootNode = this.getDOMNode();
        if (this.props.checked != null) {
          DOMPropertyOperations.setValueForProperty(rootNode, 'checked', this.props.checked || false);
        }
        var value = LinkedValueUtils.getValue(this);
        if (value != null) {
          DOMPropertyOperations.setValueForProperty(rootNode, 'value', '' + value);
        }
      },
      _handleChange: function(event) {
        var returnValue;
        var onChange = LinkedValueUtils.getOnChange(this);
        if (onChange) {
          returnValue = onChange.call(this, event);
        }
        ReactUpdates.asap(forceUpdateIfMounted, this);
        var name = this.props.name;
        if (this.props.type === 'radio' && name != null) {
          var rootNode = this.getDOMNode();
          var queryRoot = rootNode;
          while (queryRoot.parentNode) {
            queryRoot = queryRoot.parentNode;
          }
          var group = queryRoot.querySelectorAll('input[name=' + JSON.stringify('' + name) + '][type="radio"]');
          for (var i = 0,
              groupLen = group.length; i < groupLen; i++) {
            var otherNode = group[i];
            if (otherNode === rootNode || otherNode.form !== rootNode.form) {
              continue;
            }
            var otherID = ReactMount.getID(otherNode);
            ("production" !== process.env.NODE_ENV ? invariant(otherID, 'ReactDOMInput: Mixing React and non-React radio inputs with the ' + 'same `name` is not supported.') : invariant(otherID));
            var otherInstance = instancesByReactID[otherID];
            ("production" !== process.env.NODE_ENV ? invariant(otherInstance, 'ReactDOMInput: Unknown radio button ID %s.', otherID) : invariant(otherInstance));
            ReactUpdates.asap(forceUpdateIfMounted, otherInstance);
          }
        }
        return returnValue;
      }
    });
    module.exports = ReactDOMInput;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactInputSelection", ["npm:react@0.13.3/lib/ReactDOMSelection", "npm:react@0.13.3/lib/containsNode", "npm:react@0.13.3/lib/focusNode", "npm:react@0.13.3/lib/getActiveElement"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ReactDOMSelection = require("npm:react@0.13.3/lib/ReactDOMSelection");
  var containsNode = require("npm:react@0.13.3/lib/containsNode");
  var focusNode = require("npm:react@0.13.3/lib/focusNode");
  var getActiveElement = require("npm:react@0.13.3/lib/getActiveElement");
  function isInDocument(node) {
    return containsNode(document.documentElement, node);
  }
  var ReactInputSelection = {
    hasSelectionCapabilities: function(elem) {
      return elem && (((elem.nodeName === 'INPUT' && elem.type === 'text') || elem.nodeName === 'TEXTAREA' || elem.contentEditable === 'true'));
    },
    getSelectionInformation: function() {
      var focusedElem = getActiveElement();
      return {
        focusedElem: focusedElem,
        selectionRange: ReactInputSelection.hasSelectionCapabilities(focusedElem) ? ReactInputSelection.getSelection(focusedElem) : null
      };
    },
    restoreSelection: function(priorSelectionInformation) {
      var curFocusedElem = getActiveElement();
      var priorFocusedElem = priorSelectionInformation.focusedElem;
      var priorSelectionRange = priorSelectionInformation.selectionRange;
      if (curFocusedElem !== priorFocusedElem && isInDocument(priorFocusedElem)) {
        if (ReactInputSelection.hasSelectionCapabilities(priorFocusedElem)) {
          ReactInputSelection.setSelection(priorFocusedElem, priorSelectionRange);
        }
        focusNode(priorFocusedElem);
      }
    },
    getSelection: function(input) {
      var selection;
      if ('selectionStart' in input) {
        selection = {
          start: input.selectionStart,
          end: input.selectionEnd
        };
      } else if (document.selection && input.nodeName === 'INPUT') {
        var range = document.selection.createRange();
        if (range.parentElement() === input) {
          selection = {
            start: -range.moveStart('character', -input.value.length),
            end: -range.moveEnd('character', -input.value.length)
          };
        }
      } else {
        selection = ReactDOMSelection.getOffsets(input);
      }
      return selection || {
        start: 0,
        end: 0
      };
    },
    setSelection: function(input, offsets) {
      var start = offsets.start;
      var end = offsets.end;
      if (typeof end === 'undefined') {
        end = start;
      }
      if ('selectionStart' in input) {
        input.selectionStart = start;
        input.selectionEnd = Math.min(end, input.value.length);
      } else if (document.selection && input.nodeName === 'INPUT') {
        var range = input.createTextRange();
        range.collapse(true);
        range.moveStart('character', start);
        range.moveEnd('character', end - start);
        range.select();
      } else {
        ReactDOMSelection.setOffsets(input, offsets);
      }
    }
  };
  module.exports = ReactInputSelection;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/SimpleEventPlugin", ["npm:react@0.13.3/lib/EventConstants", "npm:react@0.13.3/lib/EventPluginUtils", "npm:react@0.13.3/lib/EventPropagators", "npm:react@0.13.3/lib/SyntheticClipboardEvent", "npm:react@0.13.3/lib/SyntheticEvent", "npm:react@0.13.3/lib/SyntheticFocusEvent", "npm:react@0.13.3/lib/SyntheticKeyboardEvent", "npm:react@0.13.3/lib/SyntheticMouseEvent", "npm:react@0.13.3/lib/SyntheticDragEvent", "npm:react@0.13.3/lib/SyntheticTouchEvent", "npm:react@0.13.3/lib/SyntheticUIEvent", "npm:react@0.13.3/lib/SyntheticWheelEvent", "npm:react@0.13.3/lib/getEventCharCode", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/keyOf", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var EventConstants = require("npm:react@0.13.3/lib/EventConstants");
    var EventPluginUtils = require("npm:react@0.13.3/lib/EventPluginUtils");
    var EventPropagators = require("npm:react@0.13.3/lib/EventPropagators");
    var SyntheticClipboardEvent = require("npm:react@0.13.3/lib/SyntheticClipboardEvent");
    var SyntheticEvent = require("npm:react@0.13.3/lib/SyntheticEvent");
    var SyntheticFocusEvent = require("npm:react@0.13.3/lib/SyntheticFocusEvent");
    var SyntheticKeyboardEvent = require("npm:react@0.13.3/lib/SyntheticKeyboardEvent");
    var SyntheticMouseEvent = require("npm:react@0.13.3/lib/SyntheticMouseEvent");
    var SyntheticDragEvent = require("npm:react@0.13.3/lib/SyntheticDragEvent");
    var SyntheticTouchEvent = require("npm:react@0.13.3/lib/SyntheticTouchEvent");
    var SyntheticUIEvent = require("npm:react@0.13.3/lib/SyntheticUIEvent");
    var SyntheticWheelEvent = require("npm:react@0.13.3/lib/SyntheticWheelEvent");
    var getEventCharCode = require("npm:react@0.13.3/lib/getEventCharCode");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var keyOf = require("npm:react@0.13.3/lib/keyOf");
    var warning = require("npm:react@0.13.3/lib/warning");
    var topLevelTypes = EventConstants.topLevelTypes;
    var eventTypes = {
      blur: {phasedRegistrationNames: {
          bubbled: keyOf({onBlur: true}),
          captured: keyOf({onBlurCapture: true})
        }},
      click: {phasedRegistrationNames: {
          bubbled: keyOf({onClick: true}),
          captured: keyOf({onClickCapture: true})
        }},
      contextMenu: {phasedRegistrationNames: {
          bubbled: keyOf({onContextMenu: true}),
          captured: keyOf({onContextMenuCapture: true})
        }},
      copy: {phasedRegistrationNames: {
          bubbled: keyOf({onCopy: true}),
          captured: keyOf({onCopyCapture: true})
        }},
      cut: {phasedRegistrationNames: {
          bubbled: keyOf({onCut: true}),
          captured: keyOf({onCutCapture: true})
        }},
      doubleClick: {phasedRegistrationNames: {
          bubbled: keyOf({onDoubleClick: true}),
          captured: keyOf({onDoubleClickCapture: true})
        }},
      drag: {phasedRegistrationNames: {
          bubbled: keyOf({onDrag: true}),
          captured: keyOf({onDragCapture: true})
        }},
      dragEnd: {phasedRegistrationNames: {
          bubbled: keyOf({onDragEnd: true}),
          captured: keyOf({onDragEndCapture: true})
        }},
      dragEnter: {phasedRegistrationNames: {
          bubbled: keyOf({onDragEnter: true}),
          captured: keyOf({onDragEnterCapture: true})
        }},
      dragExit: {phasedRegistrationNames: {
          bubbled: keyOf({onDragExit: true}),
          captured: keyOf({onDragExitCapture: true})
        }},
      dragLeave: {phasedRegistrationNames: {
          bubbled: keyOf({onDragLeave: true}),
          captured: keyOf({onDragLeaveCapture: true})
        }},
      dragOver: {phasedRegistrationNames: {
          bubbled: keyOf({onDragOver: true}),
          captured: keyOf({onDragOverCapture: true})
        }},
      dragStart: {phasedRegistrationNames: {
          bubbled: keyOf({onDragStart: true}),
          captured: keyOf({onDragStartCapture: true})
        }},
      drop: {phasedRegistrationNames: {
          bubbled: keyOf({onDrop: true}),
          captured: keyOf({onDropCapture: true})
        }},
      focus: {phasedRegistrationNames: {
          bubbled: keyOf({onFocus: true}),
          captured: keyOf({onFocusCapture: true})
        }},
      input: {phasedRegistrationNames: {
          bubbled: keyOf({onInput: true}),
          captured: keyOf({onInputCapture: true})
        }},
      keyDown: {phasedRegistrationNames: {
          bubbled: keyOf({onKeyDown: true}),
          captured: keyOf({onKeyDownCapture: true})
        }},
      keyPress: {phasedRegistrationNames: {
          bubbled: keyOf({onKeyPress: true}),
          captured: keyOf({onKeyPressCapture: true})
        }},
      keyUp: {phasedRegistrationNames: {
          bubbled: keyOf({onKeyUp: true}),
          captured: keyOf({onKeyUpCapture: true})
        }},
      load: {phasedRegistrationNames: {
          bubbled: keyOf({onLoad: true}),
          captured: keyOf({onLoadCapture: true})
        }},
      error: {phasedRegistrationNames: {
          bubbled: keyOf({onError: true}),
          captured: keyOf({onErrorCapture: true})
        }},
      mouseDown: {phasedRegistrationNames: {
          bubbled: keyOf({onMouseDown: true}),
          captured: keyOf({onMouseDownCapture: true})
        }},
      mouseMove: {phasedRegistrationNames: {
          bubbled: keyOf({onMouseMove: true}),
          captured: keyOf({onMouseMoveCapture: true})
        }},
      mouseOut: {phasedRegistrationNames: {
          bubbled: keyOf({onMouseOut: true}),
          captured: keyOf({onMouseOutCapture: true})
        }},
      mouseOver: {phasedRegistrationNames: {
          bubbled: keyOf({onMouseOver: true}),
          captured: keyOf({onMouseOverCapture: true})
        }},
      mouseUp: {phasedRegistrationNames: {
          bubbled: keyOf({onMouseUp: true}),
          captured: keyOf({onMouseUpCapture: true})
        }},
      paste: {phasedRegistrationNames: {
          bubbled: keyOf({onPaste: true}),
          captured: keyOf({onPasteCapture: true})
        }},
      reset: {phasedRegistrationNames: {
          bubbled: keyOf({onReset: true}),
          captured: keyOf({onResetCapture: true})
        }},
      scroll: {phasedRegistrationNames: {
          bubbled: keyOf({onScroll: true}),
          captured: keyOf({onScrollCapture: true})
        }},
      submit: {phasedRegistrationNames: {
          bubbled: keyOf({onSubmit: true}),
          captured: keyOf({onSubmitCapture: true})
        }},
      touchCancel: {phasedRegistrationNames: {
          bubbled: keyOf({onTouchCancel: true}),
          captured: keyOf({onTouchCancelCapture: true})
        }},
      touchEnd: {phasedRegistrationNames: {
          bubbled: keyOf({onTouchEnd: true}),
          captured: keyOf({onTouchEndCapture: true})
        }},
      touchMove: {phasedRegistrationNames: {
          bubbled: keyOf({onTouchMove: true}),
          captured: keyOf({onTouchMoveCapture: true})
        }},
      touchStart: {phasedRegistrationNames: {
          bubbled: keyOf({onTouchStart: true}),
          captured: keyOf({onTouchStartCapture: true})
        }},
      wheel: {phasedRegistrationNames: {
          bubbled: keyOf({onWheel: true}),
          captured: keyOf({onWheelCapture: true})
        }}
    };
    var topLevelEventsToDispatchConfig = {
      topBlur: eventTypes.blur,
      topClick: eventTypes.click,
      topContextMenu: eventTypes.contextMenu,
      topCopy: eventTypes.copy,
      topCut: eventTypes.cut,
      topDoubleClick: eventTypes.doubleClick,
      topDrag: eventTypes.drag,
      topDragEnd: eventTypes.dragEnd,
      topDragEnter: eventTypes.dragEnter,
      topDragExit: eventTypes.dragExit,
      topDragLeave: eventTypes.dragLeave,
      topDragOver: eventTypes.dragOver,
      topDragStart: eventTypes.dragStart,
      topDrop: eventTypes.drop,
      topError: eventTypes.error,
      topFocus: eventTypes.focus,
      topInput: eventTypes.input,
      topKeyDown: eventTypes.keyDown,
      topKeyPress: eventTypes.keyPress,
      topKeyUp: eventTypes.keyUp,
      topLoad: eventTypes.load,
      topMouseDown: eventTypes.mouseDown,
      topMouseMove: eventTypes.mouseMove,
      topMouseOut: eventTypes.mouseOut,
      topMouseOver: eventTypes.mouseOver,
      topMouseUp: eventTypes.mouseUp,
      topPaste: eventTypes.paste,
      topReset: eventTypes.reset,
      topScroll: eventTypes.scroll,
      topSubmit: eventTypes.submit,
      topTouchCancel: eventTypes.touchCancel,
      topTouchEnd: eventTypes.touchEnd,
      topTouchMove: eventTypes.touchMove,
      topTouchStart: eventTypes.touchStart,
      topWheel: eventTypes.wheel
    };
    for (var type in topLevelEventsToDispatchConfig) {
      topLevelEventsToDispatchConfig[type].dependencies = [type];
    }
    var SimpleEventPlugin = {
      eventTypes: eventTypes,
      executeDispatch: function(event, listener, domID) {
        var returnValue = EventPluginUtils.executeDispatch(event, listener, domID);
        ("production" !== process.env.NODE_ENV ? warning(typeof returnValue !== 'boolean', 'Returning `false` from an event handler is deprecated and will be ' + 'ignored in a future release. Instead, manually call ' + 'e.stopPropagation() or e.preventDefault(), as appropriate.') : null);
        if (returnValue === false) {
          event.stopPropagation();
          event.preventDefault();
        }
      },
      extractEvents: function(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent) {
        var dispatchConfig = topLevelEventsToDispatchConfig[topLevelType];
        if (!dispatchConfig) {
          return null;
        }
        var EventConstructor;
        switch (topLevelType) {
          case topLevelTypes.topInput:
          case topLevelTypes.topLoad:
          case topLevelTypes.topError:
          case topLevelTypes.topReset:
          case topLevelTypes.topSubmit:
            EventConstructor = SyntheticEvent;
            break;
          case topLevelTypes.topKeyPress:
            if (getEventCharCode(nativeEvent) === 0) {
              return null;
            }
          case topLevelTypes.topKeyDown:
          case topLevelTypes.topKeyUp:
            EventConstructor = SyntheticKeyboardEvent;
            break;
          case topLevelTypes.topBlur:
          case topLevelTypes.topFocus:
            EventConstructor = SyntheticFocusEvent;
            break;
          case topLevelTypes.topClick:
            if (nativeEvent.button === 2) {
              return null;
            }
          case topLevelTypes.topContextMenu:
          case topLevelTypes.topDoubleClick:
          case topLevelTypes.topMouseDown:
          case topLevelTypes.topMouseMove:
          case topLevelTypes.topMouseOut:
          case topLevelTypes.topMouseOver:
          case topLevelTypes.topMouseUp:
            EventConstructor = SyntheticMouseEvent;
            break;
          case topLevelTypes.topDrag:
          case topLevelTypes.topDragEnd:
          case topLevelTypes.topDragEnter:
          case topLevelTypes.topDragExit:
          case topLevelTypes.topDragLeave:
          case topLevelTypes.topDragOver:
          case topLevelTypes.topDragStart:
          case topLevelTypes.topDrop:
            EventConstructor = SyntheticDragEvent;
            break;
          case topLevelTypes.topTouchCancel:
          case topLevelTypes.topTouchEnd:
          case topLevelTypes.topTouchMove:
          case topLevelTypes.topTouchStart:
            EventConstructor = SyntheticTouchEvent;
            break;
          case topLevelTypes.topScroll:
            EventConstructor = SyntheticUIEvent;
            break;
          case topLevelTypes.topWheel:
            EventConstructor = SyntheticWheelEvent;
            break;
          case topLevelTypes.topCopy:
          case topLevelTypes.topCut:
          case topLevelTypes.topPaste:
            EventConstructor = SyntheticClipboardEvent;
            break;
        }
        ("production" !== process.env.NODE_ENV ? invariant(EventConstructor, 'SimpleEventPlugin: Unhandled event type, `%s`.', topLevelType) : invariant(EventConstructor));
        var event = EventConstructor.getPooled(dispatchConfig, topLevelTargetID, nativeEvent);
        EventPropagators.accumulateTwoPhaseDispatches(event);
        return event;
      }
    };
    module.exports = SimpleEventPlugin;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDefaultPerf", ["npm:react@0.13.3/lib/DOMProperty", "npm:react@0.13.3/lib/ReactDefaultPerfAnalysis", "npm:react@0.13.3/lib/ReactMount", "npm:react@0.13.3/lib/ReactPerf", "npm:react@0.13.3/lib/performanceNow"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var DOMProperty = require("npm:react@0.13.3/lib/DOMProperty");
  var ReactDefaultPerfAnalysis = require("npm:react@0.13.3/lib/ReactDefaultPerfAnalysis");
  var ReactMount = require("npm:react@0.13.3/lib/ReactMount");
  var ReactPerf = require("npm:react@0.13.3/lib/ReactPerf");
  var performanceNow = require("npm:react@0.13.3/lib/performanceNow");
  function roundFloat(val) {
    return Math.floor(val * 100) / 100;
  }
  function addValue(obj, key, val) {
    obj[key] = (obj[key] || 0) + val;
  }
  var ReactDefaultPerf = {
    _allMeasurements: [],
    _mountStack: [0],
    _injected: false,
    start: function() {
      if (!ReactDefaultPerf._injected) {
        ReactPerf.injection.injectMeasure(ReactDefaultPerf.measure);
      }
      ReactDefaultPerf._allMeasurements.length = 0;
      ReactPerf.enableMeasure = true;
    },
    stop: function() {
      ReactPerf.enableMeasure = false;
    },
    getLastMeasurements: function() {
      return ReactDefaultPerf._allMeasurements;
    },
    printExclusive: function(measurements) {
      measurements = measurements || ReactDefaultPerf._allMeasurements;
      var summary = ReactDefaultPerfAnalysis.getExclusiveSummary(measurements);
      console.table(summary.map(function(item) {
        return {
          'Component class name': item.componentName,
          'Total inclusive time (ms)': roundFloat(item.inclusive),
          'Exclusive mount time (ms)': roundFloat(item.exclusive),
          'Exclusive render time (ms)': roundFloat(item.render),
          'Mount time per instance (ms)': roundFloat(item.exclusive / item.count),
          'Render time per instance (ms)': roundFloat(item.render / item.count),
          'Instances': item.count
        };
      }));
    },
    printInclusive: function(measurements) {
      measurements = measurements || ReactDefaultPerf._allMeasurements;
      var summary = ReactDefaultPerfAnalysis.getInclusiveSummary(measurements);
      console.table(summary.map(function(item) {
        return {
          'Owner > component': item.componentName,
          'Inclusive time (ms)': roundFloat(item.time),
          'Instances': item.count
        };
      }));
      console.log('Total time:', ReactDefaultPerfAnalysis.getTotalTime(measurements).toFixed(2) + ' ms');
    },
    getMeasurementsSummaryMap: function(measurements) {
      var summary = ReactDefaultPerfAnalysis.getInclusiveSummary(measurements, true);
      return summary.map(function(item) {
        return {
          'Owner > component': item.componentName,
          'Wasted time (ms)': item.time,
          'Instances': item.count
        };
      });
    },
    printWasted: function(measurements) {
      measurements = measurements || ReactDefaultPerf._allMeasurements;
      console.table(ReactDefaultPerf.getMeasurementsSummaryMap(measurements));
      console.log('Total time:', ReactDefaultPerfAnalysis.getTotalTime(measurements).toFixed(2) + ' ms');
    },
    printDOM: function(measurements) {
      measurements = measurements || ReactDefaultPerf._allMeasurements;
      var summary = ReactDefaultPerfAnalysis.getDOMSummary(measurements);
      console.table(summary.map(function(item) {
        var result = {};
        result[DOMProperty.ID_ATTRIBUTE_NAME] = item.id;
        result['type'] = item.type;
        result['args'] = JSON.stringify(item.args);
        return result;
      }));
      console.log('Total time:', ReactDefaultPerfAnalysis.getTotalTime(measurements).toFixed(2) + ' ms');
    },
    _recordWrite: function(id, fnName, totalTime, args) {
      var writes = ReactDefaultPerf._allMeasurements[ReactDefaultPerf._allMeasurements.length - 1].writes;
      writes[id] = writes[id] || [];
      writes[id].push({
        type: fnName,
        time: totalTime,
        args: args
      });
    },
    measure: function(moduleName, fnName, func) {
      return function() {
        for (var args = [],
            $__0 = 0,
            $__1 = arguments.length; $__0 < $__1; $__0++)
          args.push(arguments[$__0]);
        var totalTime;
        var rv;
        var start;
        if (fnName === '_renderNewRootComponent' || fnName === 'flushBatchedUpdates') {
          ReactDefaultPerf._allMeasurements.push({
            exclusive: {},
            inclusive: {},
            render: {},
            counts: {},
            writes: {},
            displayNames: {},
            totalTime: 0
          });
          start = performanceNow();
          rv = func.apply(this, args);
          ReactDefaultPerf._allMeasurements[ReactDefaultPerf._allMeasurements.length - 1].totalTime = performanceNow() - start;
          return rv;
        } else if (fnName === '_mountImageIntoNode' || moduleName === 'ReactDOMIDOperations') {
          start = performanceNow();
          rv = func.apply(this, args);
          totalTime = performanceNow() - start;
          if (fnName === '_mountImageIntoNode') {
            var mountID = ReactMount.getID(args[1]);
            ReactDefaultPerf._recordWrite(mountID, fnName, totalTime, args[0]);
          } else if (fnName === 'dangerouslyProcessChildrenUpdates') {
            args[0].forEach(function(update) {
              var writeArgs = {};
              if (update.fromIndex !== null) {
                writeArgs.fromIndex = update.fromIndex;
              }
              if (update.toIndex !== null) {
                writeArgs.toIndex = update.toIndex;
              }
              if (update.textContent !== null) {
                writeArgs.textContent = update.textContent;
              }
              if (update.markupIndex !== null) {
                writeArgs.markup = args[1][update.markupIndex];
              }
              ReactDefaultPerf._recordWrite(update.parentID, update.type, totalTime, writeArgs);
            });
          } else {
            ReactDefaultPerf._recordWrite(args[0], fnName, totalTime, Array.prototype.slice.call(args, 1));
          }
          return rv;
        } else if (moduleName === 'ReactCompositeComponent' && (((fnName === 'mountComponent' || fnName === 'updateComponent' || fnName === '_renderValidatedComponent')))) {
          if (typeof this._currentElement.type === 'string') {
            return func.apply(this, args);
          }
          var rootNodeID = fnName === 'mountComponent' ? args[0] : this._rootNodeID;
          var isRender = fnName === '_renderValidatedComponent';
          var isMount = fnName === 'mountComponent';
          var mountStack = ReactDefaultPerf._mountStack;
          var entry = ReactDefaultPerf._allMeasurements[ReactDefaultPerf._allMeasurements.length - 1];
          if (isRender) {
            addValue(entry.counts, rootNodeID, 1);
          } else if (isMount) {
            mountStack.push(0);
          }
          start = performanceNow();
          rv = func.apply(this, args);
          totalTime = performanceNow() - start;
          if (isRender) {
            addValue(entry.render, rootNodeID, totalTime);
          } else if (isMount) {
            var subMountTime = mountStack.pop();
            mountStack[mountStack.length - 1] += totalTime;
            addValue(entry.exclusive, rootNodeID, totalTime - subMountTime);
            addValue(entry.inclusive, rootNodeID, totalTime);
          } else {
            addValue(entry.inclusive, rootNodeID, totalTime);
          }
          entry.displayNames[rootNodeID] = {
            current: this.getName(),
            owner: this._currentElement._owner ? this._currentElement._owner.getName() : '<root>'
          };
          return rv;
        } else {
          return func.apply(this, args);
        }
      };
    }
  };
  module.exports = ReactDefaultPerf;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseIsEqualDeep", ["npm:lodash@3.9.1/internal/equalArrays", "npm:lodash@3.9.1/internal/equalByTag", "npm:lodash@3.9.1/internal/equalObjects", "npm:lodash@3.9.1/lang/isArray", "npm:lodash@3.9.1/lang/isTypedArray"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var equalArrays = require("npm:lodash@3.9.1/internal/equalArrays"),
      equalByTag = require("npm:lodash@3.9.1/internal/equalByTag"),
      equalObjects = require("npm:lodash@3.9.1/internal/equalObjects"),
      isArray = require("npm:lodash@3.9.1/lang/isArray"),
      isTypedArray = require("npm:lodash@3.9.1/lang/isTypedArray");
  var argsTag = '[object Arguments]',
      arrayTag = '[object Array]',
      objectTag = '[object Object]';
  var objectProto = Object.prototype;
  var hasOwnProperty = objectProto.hasOwnProperty;
  var objToString = objectProto.toString;
  function baseIsEqualDeep(object, other, equalFunc, customizer, isLoose, stackA, stackB) {
    var objIsArr = isArray(object),
        othIsArr = isArray(other),
        objTag = arrayTag,
        othTag = arrayTag;
    if (!objIsArr) {
      objTag = objToString.call(object);
      if (objTag == argsTag) {
        objTag = objectTag;
      } else if (objTag != objectTag) {
        objIsArr = isTypedArray(object);
      }
    }
    if (!othIsArr) {
      othTag = objToString.call(other);
      if (othTag == argsTag) {
        othTag = objectTag;
      } else if (othTag != objectTag) {
        othIsArr = isTypedArray(other);
      }
    }
    var objIsObj = objTag == objectTag,
        othIsObj = othTag == objectTag,
        isSameTag = objTag == othTag;
    if (isSameTag && !(objIsArr || objIsObj)) {
      return equalByTag(object, other, objTag);
    }
    if (!isLoose) {
      var objIsWrapped = objIsObj && hasOwnProperty.call(object, '__wrapped__'),
          othIsWrapped = othIsObj && hasOwnProperty.call(other, '__wrapped__');
      if (objIsWrapped || othIsWrapped) {
        return equalFunc(objIsWrapped ? object.value() : object, othIsWrapped ? other.value() : other, customizer, isLoose, stackA, stackB);
      }
    }
    if (!isSameTag) {
      return false;
    }
    stackA || (stackA = []);
    stackB || (stackB = []);
    var length = stackA.length;
    while (length--) {
      if (stackA[length] == object) {
        return stackB[length] == other;
      }
    }
    stackA.push(object);
    stackB.push(other);
    var result = (objIsArr ? equalArrays : equalObjects)(object, other, equalFunc, customizer, isLoose, stackA, stackB);
    stackA.pop();
    stackB.pop();
    return result;
  }
  module.exports = baseIsEqualDeep;
  global.define = __define;
  return module.exports;
});



System.register("npm:color-convert@0.5.2", ["npm:color-convert@0.5.2/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:color-convert@0.5.2/index");
  global.define = __define;
  return module.exports;
});



System.register("npm:color-string@0.3.0/color-string", ["npm:color-name@1.0.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var colorNames = require("npm:color-name@1.0.0");
  module.exports = {
    getRgba: getRgba,
    getHsla: getHsla,
    getRgb: getRgb,
    getHsl: getHsl,
    getHwb: getHwb,
    getAlpha: getAlpha,
    hexString: hexString,
    rgbString: rgbString,
    rgbaString: rgbaString,
    percentString: percentString,
    percentaString: percentaString,
    hslString: hslString,
    hslaString: hslaString,
    hwbString: hwbString,
    keyword: keyword
  };
  function getRgba(string) {
    if (!string) {
      return ;
    }
    var abbr = /^#([a-fA-F0-9]{3})$/,
        hex = /^#([a-fA-F0-9]{6})$/,
        rgba = /^rgba?\(\s*([+-]?\d+)\s*,\s*([+-]?\d+)\s*,\s*([+-]?\d+)\s*(?:,\s*([+-]?[\d\.]+)\s*)?\)$/,
        per = /^rgba?\(\s*([+-]?[\d\.]+)\%\s*,\s*([+-]?[\d\.]+)\%\s*,\s*([+-]?[\d\.]+)\%\s*(?:,\s*([+-]?[\d\.]+)\s*)?\)$/,
        keyword = /(\D+)/;
    var rgb = [0, 0, 0],
        a = 1,
        match = string.match(abbr);
    if (match) {
      match = match[1];
      for (var i = 0; i < rgb.length; i++) {
        rgb[i] = parseInt(match[i] + match[i], 16);
      }
    } else if (match = string.match(hex)) {
      match = match[1];
      for (var i = 0; i < rgb.length; i++) {
        rgb[i] = parseInt(match.slice(i * 2, i * 2 + 2), 16);
      }
    } else if (match = string.match(rgba)) {
      for (var i = 0; i < rgb.length; i++) {
        rgb[i] = parseInt(match[i + 1]);
      }
      a = parseFloat(match[4]);
    } else if (match = string.match(per)) {
      for (var i = 0; i < rgb.length; i++) {
        rgb[i] = Math.round(parseFloat(match[i + 1]) * 2.55);
      }
      a = parseFloat(match[4]);
    } else if (match = string.match(keyword)) {
      if (match[1] == "transparent") {
        return [0, 0, 0, 0];
      }
      rgb = colorNames[match[1]];
      if (!rgb) {
        return ;
      }
    }
    for (var i = 0; i < rgb.length; i++) {
      rgb[i] = scale(rgb[i], 0, 255);
    }
    if (!a && a != 0) {
      a = 1;
    } else {
      a = scale(a, 0, 1);
    }
    rgb[3] = a;
    return rgb;
  }
  function getHsla(string) {
    if (!string) {
      return ;
    }
    var hsl = /^hsla?\(\s*([+-]?\d+)(?:deg)?\s*,\s*([+-]?[\d\.]+)%\s*,\s*([+-]?[\d\.]+)%\s*(?:,\s*([+-]?[\d\.]+)\s*)?\)/;
    var match = string.match(hsl);
    if (match) {
      var alpha = parseFloat(match[4]);
      var h = scale(parseInt(match[1]), 0, 360),
          s = scale(parseFloat(match[2]), 0, 100),
          l = scale(parseFloat(match[3]), 0, 100),
          a = scale(isNaN(alpha) ? 1 : alpha, 0, 1);
      return [h, s, l, a];
    }
  }
  function getHwb(string) {
    if (!string) {
      return ;
    }
    var hwb = /^hwb\(\s*([+-]?\d+)(?:deg)?\s*,\s*([+-]?[\d\.]+)%\s*,\s*([+-]?[\d\.]+)%\s*(?:,\s*([+-]?[\d\.]+)\s*)?\)/;
    var match = string.match(hwb);
    if (match) {
      var alpha = parseFloat(match[4]);
      var h = scale(parseInt(match[1]), 0, 360),
          w = scale(parseFloat(match[2]), 0, 100),
          b = scale(parseFloat(match[3]), 0, 100),
          a = scale(isNaN(alpha) ? 1 : alpha, 0, 1);
      return [h, w, b, a];
    }
  }
  function getRgb(string) {
    var rgba = getRgba(string);
    return rgba && rgba.slice(0, 3);
  }
  function getHsl(string) {
    var hsla = getHsla(string);
    return hsla && hsla.slice(0, 3);
  }
  function getAlpha(string) {
    var vals = getRgba(string);
    if (vals) {
      return vals[3];
    } else if (vals = getHsla(string)) {
      return vals[3];
    } else if (vals = getHwb(string)) {
      return vals[3];
    }
  }
  function hexString(rgb) {
    return "#" + hexDouble(rgb[0]) + hexDouble(rgb[1]) + hexDouble(rgb[2]);
  }
  function rgbString(rgba, alpha) {
    if (alpha < 1 || (rgba[3] && rgba[3] < 1)) {
      return rgbaString(rgba, alpha);
    }
    return "rgb(" + rgba[0] + ", " + rgba[1] + ", " + rgba[2] + ")";
  }
  function rgbaString(rgba, alpha) {
    if (alpha === undefined) {
      alpha = (rgba[3] !== undefined ? rgba[3] : 1);
    }
    return "rgba(" + rgba[0] + ", " + rgba[1] + ", " + rgba[2] + ", " + alpha + ")";
  }
  function percentString(rgba, alpha) {
    if (alpha < 1 || (rgba[3] && rgba[3] < 1)) {
      return percentaString(rgba, alpha);
    }
    var r = Math.round(rgba[0] / 255 * 100),
        g = Math.round(rgba[1] / 255 * 100),
        b = Math.round(rgba[2] / 255 * 100);
    return "rgb(" + r + "%, " + g + "%, " + b + "%)";
  }
  function percentaString(rgba, alpha) {
    var r = Math.round(rgba[0] / 255 * 100),
        g = Math.round(rgba[1] / 255 * 100),
        b = Math.round(rgba[2] / 255 * 100);
    return "rgba(" + r + "%, " + g + "%, " + b + "%, " + (alpha || rgba[3] || 1) + ")";
  }
  function hslString(hsla, alpha) {
    if (alpha < 1 || (hsla[3] && hsla[3] < 1)) {
      return hslaString(hsla, alpha);
    }
    return "hsl(" + hsla[0] + ", " + hsla[1] + "%, " + hsla[2] + "%)";
  }
  function hslaString(hsla, alpha) {
    if (alpha === undefined) {
      alpha = (hsla[3] !== undefined ? hsla[3] : 1);
    }
    return "hsla(" + hsla[0] + ", " + hsla[1] + "%, " + hsla[2] + "%, " + alpha + ")";
  }
  function hwbString(hwb, alpha) {
    if (alpha === undefined) {
      alpha = (hwb[3] !== undefined ? hwb[3] : 1);
    }
    return "hwb(" + hwb[0] + ", " + hwb[1] + "%, " + hwb[2] + "%" + (alpha !== undefined && alpha !== 1 ? ", " + alpha : "") + ")";
  }
  function keyword(rgb) {
    return reverseNames[rgb.slice(0, 3)];
  }
  function scale(num, min, max) {
    return Math.min(Math.max(min, num), max);
  }
  function hexDouble(num) {
    var str = num.toString(16).toUpperCase();
    return (str.length < 2) ? "0" + str : str;
  }
  var reverseNames = {};
  for (var name in colorNames) {
    reverseNames[colorNames[name]] = name;
  }
  global.define = __define;
  return module.exports;
});



System.register("npm:flux@2.0.3/index", ["npm:flux@2.0.3/lib/Dispatcher"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports.Dispatcher = require("npm:flux@2.0.3/lib/Dispatcher");
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/lang/isArguments", ["npm:lodash@3.9.1/internal/isArrayLike", "npm:lodash@3.9.1/internal/isObjectLike"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isArrayLike = require("npm:lodash@3.9.1/internal/isArrayLike"),
      isObjectLike = require("npm:lodash@3.9.1/internal/isObjectLike");
  var argsTag = '[object Arguments]';
  var objectProto = Object.prototype;
  var objToString = objectProto.toString;
  function isArguments(value) {
    return isObjectLike(value) && isArrayLike(value) && objToString.call(value) == argsTag;
  }
  module.exports = isArguments;
  global.define = __define;
  return module.exports;
});



System.register("github:jspm/nodelibs-process@0.1.1", ["github:jspm/nodelibs-process@0.1.1/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:jspm/nodelibs-process@0.1.1/index");
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseFor", ["npm:lodash@3.9.1/internal/createBaseFor"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var createBaseFor = require("npm:lodash@3.9.1/internal/createBaseFor");
  var baseFor = createBaseFor();
  module.exports = baseFor;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/EventPluginUtils", ["npm:react@0.13.3/lib/EventConstants", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var EventConstants = require("npm:react@0.13.3/lib/EventConstants");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var injection = {
      Mount: null,
      injectMount: function(InjectedMount) {
        injection.Mount = InjectedMount;
        if ("production" !== process.env.NODE_ENV) {
          ("production" !== process.env.NODE_ENV ? invariant(InjectedMount && InjectedMount.getNode, 'EventPluginUtils.injection.injectMount(...): Injected Mount module ' + 'is missing getNode.') : invariant(InjectedMount && InjectedMount.getNode));
        }
      }
    };
    var topLevelTypes = EventConstants.topLevelTypes;
    function isEndish(topLevelType) {
      return topLevelType === topLevelTypes.topMouseUp || topLevelType === topLevelTypes.topTouchEnd || topLevelType === topLevelTypes.topTouchCancel;
    }
    function isMoveish(topLevelType) {
      return topLevelType === topLevelTypes.topMouseMove || topLevelType === topLevelTypes.topTouchMove;
    }
    function isStartish(topLevelType) {
      return topLevelType === topLevelTypes.topMouseDown || topLevelType === topLevelTypes.topTouchStart;
    }
    var validateEventDispatches;
    if ("production" !== process.env.NODE_ENV) {
      validateEventDispatches = function(event) {
        var dispatchListeners = event._dispatchListeners;
        var dispatchIDs = event._dispatchIDs;
        var listenersIsArr = Array.isArray(dispatchListeners);
        var idsIsArr = Array.isArray(dispatchIDs);
        var IDsLen = idsIsArr ? dispatchIDs.length : dispatchIDs ? 1 : 0;
        var listenersLen = listenersIsArr ? dispatchListeners.length : dispatchListeners ? 1 : 0;
        ("production" !== process.env.NODE_ENV ? invariant(idsIsArr === listenersIsArr && IDsLen === listenersLen, 'EventPluginUtils: Invalid `event`.') : invariant(idsIsArr === listenersIsArr && IDsLen === listenersLen));
      };
    }
    function forEachEventDispatch(event, cb) {
      var dispatchListeners = event._dispatchListeners;
      var dispatchIDs = event._dispatchIDs;
      if ("production" !== process.env.NODE_ENV) {
        validateEventDispatches(event);
      }
      if (Array.isArray(dispatchListeners)) {
        for (var i = 0; i < dispatchListeners.length; i++) {
          if (event.isPropagationStopped()) {
            break;
          }
          cb(event, dispatchListeners[i], dispatchIDs[i]);
        }
      } else if (dispatchListeners) {
        cb(event, dispatchListeners, dispatchIDs);
      }
    }
    function executeDispatch(event, listener, domID) {
      event.currentTarget = injection.Mount.getNode(domID);
      var returnValue = listener(event, domID);
      event.currentTarget = null;
      return returnValue;
    }
    function executeDispatchesInOrder(event, cb) {
      forEachEventDispatch(event, cb);
      event._dispatchListeners = null;
      event._dispatchIDs = null;
    }
    function executeDispatchesInOrderStopAtTrueImpl(event) {
      var dispatchListeners = event._dispatchListeners;
      var dispatchIDs = event._dispatchIDs;
      if ("production" !== process.env.NODE_ENV) {
        validateEventDispatches(event);
      }
      if (Array.isArray(dispatchListeners)) {
        for (var i = 0; i < dispatchListeners.length; i++) {
          if (event.isPropagationStopped()) {
            break;
          }
          if (dispatchListeners[i](event, dispatchIDs[i])) {
            return dispatchIDs[i];
          }
        }
      } else if (dispatchListeners) {
        if (dispatchListeners(event, dispatchIDs)) {
          return dispatchIDs;
        }
      }
      return null;
    }
    function executeDispatchesInOrderStopAtTrue(event) {
      var ret = executeDispatchesInOrderStopAtTrueImpl(event);
      event._dispatchIDs = null;
      event._dispatchListeners = null;
      return ret;
    }
    function executeDirectDispatch(event) {
      if ("production" !== process.env.NODE_ENV) {
        validateEventDispatches(event);
      }
      var dispatchListener = event._dispatchListeners;
      var dispatchID = event._dispatchIDs;
      ("production" !== process.env.NODE_ENV ? invariant(!Array.isArray(dispatchListener), 'executeDirectDispatch(...): Invalid `event`.') : invariant(!Array.isArray(dispatchListener)));
      var res = dispatchListener ? dispatchListener(event, dispatchID) : null;
      event._dispatchListeners = null;
      event._dispatchIDs = null;
      return res;
    }
    function hasDispatches(event) {
      return !!event._dispatchListeners;
    }
    var EventPluginUtils = {
      isEndish: isEndish,
      isMoveish: isMoveish,
      isStartish: isStartish,
      executeDirectDispatch: executeDirectDispatch,
      executeDispatch: executeDispatch,
      executeDispatchesInOrder: executeDispatchesInOrder,
      executeDispatchesInOrderStopAtTrue: executeDispatchesInOrderStopAtTrue,
      hasDispatches: hasDispatches,
      injection: injection,
      useTouchEvents: false
    };
    module.exports = EventPluginUtils;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactElement", ["npm:react@0.13.3/lib/ReactContext", "npm:react@0.13.3/lib/ReactCurrentOwner", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactContext = require("npm:react@0.13.3/lib/ReactContext");
    var ReactCurrentOwner = require("npm:react@0.13.3/lib/ReactCurrentOwner");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var warning = require("npm:react@0.13.3/lib/warning");
    var RESERVED_PROPS = {
      key: true,
      ref: true
    };
    function defineWarningProperty(object, key) {
      Object.defineProperty(object, key, {
        configurable: false,
        enumerable: true,
        get: function() {
          if (!this._store) {
            return null;
          }
          return this._store[key];
        },
        set: function(value) {
          ("production" !== process.env.NODE_ENV ? warning(false, 'Don\'t set the %s property of the React element. Instead, ' + 'specify the correct value when initially creating the element.', key) : null);
          this._store[key] = value;
        }
      });
    }
    var useMutationMembrane = false;
    function defineMutationMembrane(prototype) {
      try {
        var pseudoFrozenProperties = {props: true};
        for (var key in pseudoFrozenProperties) {
          defineWarningProperty(prototype, key);
        }
        useMutationMembrane = true;
      } catch (x) {}
    }
    var ReactElement = function(type, key, ref, owner, context, props) {
      this.type = type;
      this.key = key;
      this.ref = ref;
      this._owner = owner;
      this._context = context;
      if ("production" !== process.env.NODE_ENV) {
        this._store = {
          props: props,
          originalProps: assign({}, props)
        };
        try {
          Object.defineProperty(this._store, 'validated', {
            configurable: false,
            enumerable: false,
            writable: true
          });
        } catch (x) {}
        this._store.validated = false;
        if (useMutationMembrane) {
          Object.freeze(this);
          return ;
        }
      }
      this.props = props;
    };
    ReactElement.prototype = {_isReactElement: true};
    if ("production" !== process.env.NODE_ENV) {
      defineMutationMembrane(ReactElement.prototype);
    }
    ReactElement.createElement = function(type, config, children) {
      var propName;
      var props = {};
      var key = null;
      var ref = null;
      if (config != null) {
        ref = config.ref === undefined ? null : config.ref;
        key = config.key === undefined ? null : '' + config.key;
        for (propName in config) {
          if (config.hasOwnProperty(propName) && !RESERVED_PROPS.hasOwnProperty(propName)) {
            props[propName] = config[propName];
          }
        }
      }
      var childrenLength = arguments.length - 2;
      if (childrenLength === 1) {
        props.children = children;
      } else if (childrenLength > 1) {
        var childArray = Array(childrenLength);
        for (var i = 0; i < childrenLength; i++) {
          childArray[i] = arguments[i + 2];
        }
        props.children = childArray;
      }
      if (type && type.defaultProps) {
        var defaultProps = type.defaultProps;
        for (propName in defaultProps) {
          if (typeof props[propName] === 'undefined') {
            props[propName] = defaultProps[propName];
          }
        }
      }
      return new ReactElement(type, key, ref, ReactCurrentOwner.current, ReactContext.current, props);
    };
    ReactElement.createFactory = function(type) {
      var factory = ReactElement.createElement.bind(null, type);
      factory.type = type;
      return factory;
    };
    ReactElement.cloneAndReplaceProps = function(oldElement, newProps) {
      var newElement = new ReactElement(oldElement.type, oldElement.key, oldElement.ref, oldElement._owner, oldElement._context, newProps);
      if ("production" !== process.env.NODE_ENV) {
        newElement._store.validated = oldElement._store.validated;
      }
      return newElement;
    };
    ReactElement.cloneElement = function(element, config, children) {
      var propName;
      var props = assign({}, element.props);
      var key = element.key;
      var ref = element.ref;
      var owner = element._owner;
      if (config != null) {
        if (config.ref !== undefined) {
          ref = config.ref;
          owner = ReactCurrentOwner.current;
        }
        if (config.key !== undefined) {
          key = '' + config.key;
        }
        for (propName in config) {
          if (config.hasOwnProperty(propName) && !RESERVED_PROPS.hasOwnProperty(propName)) {
            props[propName] = config[propName];
          }
        }
      }
      var childrenLength = arguments.length - 2;
      if (childrenLength === 1) {
        props.children = children;
      } else if (childrenLength > 1) {
        var childArray = Array(childrenLength);
        for (var i = 0; i < childrenLength; i++) {
          childArray[i] = arguments[i + 2];
        }
        props.children = childArray;
      }
      return new ReactElement(element.type, key, ref, owner, element._context, props);
    };
    ReactElement.isValidElement = function(object) {
      var isElement = !!(object && object._isReactElement);
      return isElement;
    };
    module.exports = ReactElement;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactUpdates", ["npm:react@0.13.3/lib/CallbackQueue", "npm:react@0.13.3/lib/PooledClass", "npm:react@0.13.3/lib/ReactCurrentOwner", "npm:react@0.13.3/lib/ReactPerf", "npm:react@0.13.3/lib/ReactReconciler", "npm:react@0.13.3/lib/Transaction", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var CallbackQueue = require("npm:react@0.13.3/lib/CallbackQueue");
    var PooledClass = require("npm:react@0.13.3/lib/PooledClass");
    var ReactCurrentOwner = require("npm:react@0.13.3/lib/ReactCurrentOwner");
    var ReactPerf = require("npm:react@0.13.3/lib/ReactPerf");
    var ReactReconciler = require("npm:react@0.13.3/lib/ReactReconciler");
    var Transaction = require("npm:react@0.13.3/lib/Transaction");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var warning = require("npm:react@0.13.3/lib/warning");
    var dirtyComponents = [];
    var asapCallbackQueue = CallbackQueue.getPooled();
    var asapEnqueued = false;
    var batchingStrategy = null;
    function ensureInjected() {
      ("production" !== process.env.NODE_ENV ? invariant(ReactUpdates.ReactReconcileTransaction && batchingStrategy, 'ReactUpdates: must inject a reconcile transaction class and batching ' + 'strategy') : invariant(ReactUpdates.ReactReconcileTransaction && batchingStrategy));
    }
    var NESTED_UPDATES = {
      initialize: function() {
        this.dirtyComponentsLength = dirtyComponents.length;
      },
      close: function() {
        if (this.dirtyComponentsLength !== dirtyComponents.length) {
          dirtyComponents.splice(0, this.dirtyComponentsLength);
          flushBatchedUpdates();
        } else {
          dirtyComponents.length = 0;
        }
      }
    };
    var UPDATE_QUEUEING = {
      initialize: function() {
        this.callbackQueue.reset();
      },
      close: function() {
        this.callbackQueue.notifyAll();
      }
    };
    var TRANSACTION_WRAPPERS = [NESTED_UPDATES, UPDATE_QUEUEING];
    function ReactUpdatesFlushTransaction() {
      this.reinitializeTransaction();
      this.dirtyComponentsLength = null;
      this.callbackQueue = CallbackQueue.getPooled();
      this.reconcileTransaction = ReactUpdates.ReactReconcileTransaction.getPooled();
    }
    assign(ReactUpdatesFlushTransaction.prototype, Transaction.Mixin, {
      getTransactionWrappers: function() {
        return TRANSACTION_WRAPPERS;
      },
      destructor: function() {
        this.dirtyComponentsLength = null;
        CallbackQueue.release(this.callbackQueue);
        this.callbackQueue = null;
        ReactUpdates.ReactReconcileTransaction.release(this.reconcileTransaction);
        this.reconcileTransaction = null;
      },
      perform: function(method, scope, a) {
        return Transaction.Mixin.perform.call(this, this.reconcileTransaction.perform, this.reconcileTransaction, method, scope, a);
      }
    });
    PooledClass.addPoolingTo(ReactUpdatesFlushTransaction);
    function batchedUpdates(callback, a, b, c, d) {
      ensureInjected();
      batchingStrategy.batchedUpdates(callback, a, b, c, d);
    }
    function mountOrderComparator(c1, c2) {
      return c1._mountOrder - c2._mountOrder;
    }
    function runBatchedUpdates(transaction) {
      var len = transaction.dirtyComponentsLength;
      ("production" !== process.env.NODE_ENV ? invariant(len === dirtyComponents.length, 'Expected flush transaction\'s stored dirty-components length (%s) to ' + 'match dirty-components array length (%s).', len, dirtyComponents.length) : invariant(len === dirtyComponents.length));
      dirtyComponents.sort(mountOrderComparator);
      for (var i = 0; i < len; i++) {
        var component = dirtyComponents[i];
        var callbacks = component._pendingCallbacks;
        component._pendingCallbacks = null;
        ReactReconciler.performUpdateIfNecessary(component, transaction.reconcileTransaction);
        if (callbacks) {
          for (var j = 0; j < callbacks.length; j++) {
            transaction.callbackQueue.enqueue(callbacks[j], component.getPublicInstance());
          }
        }
      }
    }
    var flushBatchedUpdates = function() {
      while (dirtyComponents.length || asapEnqueued) {
        if (dirtyComponents.length) {
          var transaction = ReactUpdatesFlushTransaction.getPooled();
          transaction.perform(runBatchedUpdates, null, transaction);
          ReactUpdatesFlushTransaction.release(transaction);
        }
        if (asapEnqueued) {
          asapEnqueued = false;
          var queue = asapCallbackQueue;
          asapCallbackQueue = CallbackQueue.getPooled();
          queue.notifyAll();
          CallbackQueue.release(queue);
        }
      }
    };
    flushBatchedUpdates = ReactPerf.measure('ReactUpdates', 'flushBatchedUpdates', flushBatchedUpdates);
    function enqueueUpdate(component) {
      ensureInjected();
      ("production" !== process.env.NODE_ENV ? warning(ReactCurrentOwner.current == null, 'enqueueUpdate(): Render methods should be a pure function of props ' + 'and state; triggering nested component updates from render is not ' + 'allowed. If necessary, trigger nested updates in ' + 'componentDidUpdate.') : null);
      if (!batchingStrategy.isBatchingUpdates) {
        batchingStrategy.batchedUpdates(enqueueUpdate, component);
        return ;
      }
      dirtyComponents.push(component);
    }
    function asap(callback, context) {
      ("production" !== process.env.NODE_ENV ? invariant(batchingStrategy.isBatchingUpdates, 'ReactUpdates.asap: Can\'t enqueue an asap callback in a context where' + 'updates are not being batched.') : invariant(batchingStrategy.isBatchingUpdates));
      asapCallbackQueue.enqueue(callback, context);
      asapEnqueued = true;
    }
    var ReactUpdatesInjection = {
      injectReconcileTransaction: function(ReconcileTransaction) {
        ("production" !== process.env.NODE_ENV ? invariant(ReconcileTransaction, 'ReactUpdates: must provide a reconcile transaction class') : invariant(ReconcileTransaction));
        ReactUpdates.ReactReconcileTransaction = ReconcileTransaction;
      },
      injectBatchingStrategy: function(_batchingStrategy) {
        ("production" !== process.env.NODE_ENV ? invariant(_batchingStrategy, 'ReactUpdates: must provide a batching strategy') : invariant(_batchingStrategy));
        ("production" !== process.env.NODE_ENV ? invariant(typeof _batchingStrategy.batchedUpdates === 'function', 'ReactUpdates: must provide a batchedUpdates() function') : invariant(typeof _batchingStrategy.batchedUpdates === 'function'));
        ("production" !== process.env.NODE_ENV ? invariant(typeof _batchingStrategy.isBatchingUpdates === 'boolean', 'ReactUpdates: must provide an isBatchingUpdates boolean attribute') : invariant(typeof _batchingStrategy.isBatchingUpdates === 'boolean'));
        batchingStrategy = _batchingStrategy;
      }
    };
    var ReactUpdates = {
      ReactReconcileTransaction: null,
      batchedUpdates: batchedUpdates,
      enqueueUpdate: enqueueUpdate,
      flushBatchedUpdates: flushBatchedUpdates,
      injection: ReactUpdatesInjection,
      asap: asap
    };
    module.exports = ReactUpdates;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/Danger", ["npm:react@0.13.3/lib/ExecutionEnvironment", "npm:react@0.13.3/lib/createNodesFromMarkup", "npm:react@0.13.3/lib/emptyFunction", "npm:react@0.13.3/lib/getMarkupWrap", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
    var createNodesFromMarkup = require("npm:react@0.13.3/lib/createNodesFromMarkup");
    var emptyFunction = require("npm:react@0.13.3/lib/emptyFunction");
    var getMarkupWrap = require("npm:react@0.13.3/lib/getMarkupWrap");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var OPEN_TAG_NAME_EXP = /^(<[^ \/>]+)/;
    var RESULT_INDEX_ATTR = 'data-danger-index';
    function getNodeName(markup) {
      return markup.substring(1, markup.indexOf(' '));
    }
    var Danger = {
      dangerouslyRenderMarkup: function(markupList) {
        ("production" !== process.env.NODE_ENV ? invariant(ExecutionEnvironment.canUseDOM, 'dangerouslyRenderMarkup(...): Cannot render markup in a worker ' + 'thread. Make sure `window` and `document` are available globally ' + 'before requiring React when unit testing or use ' + 'React.renderToString for server rendering.') : invariant(ExecutionEnvironment.canUseDOM));
        var nodeName;
        var markupByNodeName = {};
        for (var i = 0; i < markupList.length; i++) {
          ("production" !== process.env.NODE_ENV ? invariant(markupList[i], 'dangerouslyRenderMarkup(...): Missing markup.') : invariant(markupList[i]));
          nodeName = getNodeName(markupList[i]);
          nodeName = getMarkupWrap(nodeName) ? nodeName : '*';
          markupByNodeName[nodeName] = markupByNodeName[nodeName] || [];
          markupByNodeName[nodeName][i] = markupList[i];
        }
        var resultList = [];
        var resultListAssignmentCount = 0;
        for (nodeName in markupByNodeName) {
          if (!markupByNodeName.hasOwnProperty(nodeName)) {
            continue;
          }
          var markupListByNodeName = markupByNodeName[nodeName];
          var resultIndex;
          for (resultIndex in markupListByNodeName) {
            if (markupListByNodeName.hasOwnProperty(resultIndex)) {
              var markup = markupListByNodeName[resultIndex];
              markupListByNodeName[resultIndex] = markup.replace(OPEN_TAG_NAME_EXP, '$1 ' + RESULT_INDEX_ATTR + '="' + resultIndex + '" ');
            }
          }
          var renderNodes = createNodesFromMarkup(markupListByNodeName.join(''), emptyFunction);
          for (var j = 0; j < renderNodes.length; ++j) {
            var renderNode = renderNodes[j];
            if (renderNode.hasAttribute && renderNode.hasAttribute(RESULT_INDEX_ATTR)) {
              resultIndex = +renderNode.getAttribute(RESULT_INDEX_ATTR);
              renderNode.removeAttribute(RESULT_INDEX_ATTR);
              ("production" !== process.env.NODE_ENV ? invariant(!resultList.hasOwnProperty(resultIndex), 'Danger: Assigning to an already-occupied result index.') : invariant(!resultList.hasOwnProperty(resultIndex)));
              resultList[resultIndex] = renderNode;
              resultListAssignmentCount += 1;
            } else if ("production" !== process.env.NODE_ENV) {
              console.error('Danger: Discarding unexpected node:', renderNode);
            }
          }
        }
        ("production" !== process.env.NODE_ENV ? invariant(resultListAssignmentCount === resultList.length, 'Danger: Did not assign to every index of resultList.') : invariant(resultListAssignmentCount === resultList.length));
        ("production" !== process.env.NODE_ENV ? invariant(resultList.length === markupList.length, 'Danger: Expected markup to render %s nodes, but rendered %s.', markupList.length, resultList.length) : invariant(resultList.length === markupList.length));
        return resultList;
      },
      dangerouslyReplaceNodeWithMarkup: function(oldChild, markup) {
        ("production" !== process.env.NODE_ENV ? invariant(ExecutionEnvironment.canUseDOM, 'dangerouslyReplaceNodeWithMarkup(...): Cannot render markup in a ' + 'worker thread. Make sure `window` and `document` are available ' + 'globally before requiring React when unit testing or use ' + 'React.renderToString for server rendering.') : invariant(ExecutionEnvironment.canUseDOM));
        ("production" !== process.env.NODE_ENV ? invariant(markup, 'dangerouslyReplaceNodeWithMarkup(...): Missing markup.') : invariant(markup));
        ("production" !== process.env.NODE_ENV ? invariant(oldChild.tagName.toLowerCase() !== 'html', 'dangerouslyReplaceNodeWithMarkup(...): Cannot replace markup of the ' + '<html> node. This is because browser quirks make this unreliable ' + 'and/or slow. If you want to render to the root you must use ' + 'server rendering. See React.renderToString().') : invariant(oldChild.tagName.toLowerCase() !== 'html'));
        var newChild = createNodesFromMarkup(markup, emptyFunction)[0];
        oldChild.parentNode.replaceChild(newChild, oldChild);
      }
    };
    module.exports = Danger;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactMount", ["npm:react@0.13.3/lib/DOMProperty", "npm:react@0.13.3/lib/ReactBrowserEventEmitter", "npm:react@0.13.3/lib/ReactCurrentOwner", "npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactElementValidator", "npm:react@0.13.3/lib/ReactEmptyComponent", "npm:react@0.13.3/lib/ReactInstanceHandles", "npm:react@0.13.3/lib/ReactInstanceMap", "npm:react@0.13.3/lib/ReactMarkupChecksum", "npm:react@0.13.3/lib/ReactPerf", "npm:react@0.13.3/lib/ReactReconciler", "npm:react@0.13.3/lib/ReactUpdateQueue", "npm:react@0.13.3/lib/ReactUpdates", "npm:react@0.13.3/lib/emptyObject", "npm:react@0.13.3/lib/containsNode", "npm:react@0.13.3/lib/getReactRootElementInContainer", "npm:react@0.13.3/lib/instantiateReactComponent", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/setInnerHTML", "npm:react@0.13.3/lib/shouldUpdateReactComponent", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var DOMProperty = require("npm:react@0.13.3/lib/DOMProperty");
    var ReactBrowserEventEmitter = require("npm:react@0.13.3/lib/ReactBrowserEventEmitter");
    var ReactCurrentOwner = require("npm:react@0.13.3/lib/ReactCurrentOwner");
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactElementValidator = require("npm:react@0.13.3/lib/ReactElementValidator");
    var ReactEmptyComponent = require("npm:react@0.13.3/lib/ReactEmptyComponent");
    var ReactInstanceHandles = require("npm:react@0.13.3/lib/ReactInstanceHandles");
    var ReactInstanceMap = require("npm:react@0.13.3/lib/ReactInstanceMap");
    var ReactMarkupChecksum = require("npm:react@0.13.3/lib/ReactMarkupChecksum");
    var ReactPerf = require("npm:react@0.13.3/lib/ReactPerf");
    var ReactReconciler = require("npm:react@0.13.3/lib/ReactReconciler");
    var ReactUpdateQueue = require("npm:react@0.13.3/lib/ReactUpdateQueue");
    var ReactUpdates = require("npm:react@0.13.3/lib/ReactUpdates");
    var emptyObject = require("npm:react@0.13.3/lib/emptyObject");
    var containsNode = require("npm:react@0.13.3/lib/containsNode");
    var getReactRootElementInContainer = require("npm:react@0.13.3/lib/getReactRootElementInContainer");
    var instantiateReactComponent = require("npm:react@0.13.3/lib/instantiateReactComponent");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var setInnerHTML = require("npm:react@0.13.3/lib/setInnerHTML");
    var shouldUpdateReactComponent = require("npm:react@0.13.3/lib/shouldUpdateReactComponent");
    var warning = require("npm:react@0.13.3/lib/warning");
    var SEPARATOR = ReactInstanceHandles.SEPARATOR;
    var ATTR_NAME = DOMProperty.ID_ATTRIBUTE_NAME;
    var nodeCache = {};
    var ELEMENT_NODE_TYPE = 1;
    var DOC_NODE_TYPE = 9;
    var instancesByReactRootID = {};
    var containersByReactRootID = {};
    if ("production" !== process.env.NODE_ENV) {
      var rootElementsByReactRootID = {};
    }
    var findComponentRootReusableArray = [];
    function firstDifferenceIndex(string1, string2) {
      var minLen = Math.min(string1.length, string2.length);
      for (var i = 0; i < minLen; i++) {
        if (string1.charAt(i) !== string2.charAt(i)) {
          return i;
        }
      }
      return string1.length === string2.length ? -1 : minLen;
    }
    function getReactRootID(container) {
      var rootElement = getReactRootElementInContainer(container);
      return rootElement && ReactMount.getID(rootElement);
    }
    function getID(node) {
      var id = internalGetID(node);
      if (id) {
        if (nodeCache.hasOwnProperty(id)) {
          var cached = nodeCache[id];
          if (cached !== node) {
            ("production" !== process.env.NODE_ENV ? invariant(!isValid(cached, id), 'ReactMount: Two valid but unequal nodes with the same `%s`: %s', ATTR_NAME, id) : invariant(!isValid(cached, id)));
            nodeCache[id] = node;
          }
        } else {
          nodeCache[id] = node;
        }
      }
      return id;
    }
    function internalGetID(node) {
      return node && node.getAttribute && node.getAttribute(ATTR_NAME) || '';
    }
    function setID(node, id) {
      var oldID = internalGetID(node);
      if (oldID !== id) {
        delete nodeCache[oldID];
      }
      node.setAttribute(ATTR_NAME, id);
      nodeCache[id] = node;
    }
    function getNode(id) {
      if (!nodeCache.hasOwnProperty(id) || !isValid(nodeCache[id], id)) {
        nodeCache[id] = ReactMount.findReactNodeByID(id);
      }
      return nodeCache[id];
    }
    function getNodeFromInstance(instance) {
      var id = ReactInstanceMap.get(instance)._rootNodeID;
      if (ReactEmptyComponent.isNullComponentID(id)) {
        return null;
      }
      if (!nodeCache.hasOwnProperty(id) || !isValid(nodeCache[id], id)) {
        nodeCache[id] = ReactMount.findReactNodeByID(id);
      }
      return nodeCache[id];
    }
    function isValid(node, id) {
      if (node) {
        ("production" !== process.env.NODE_ENV ? invariant(internalGetID(node) === id, 'ReactMount: Unexpected modification of `%s`', ATTR_NAME) : invariant(internalGetID(node) === id));
        var container = ReactMount.findReactContainerForID(id);
        if (container && containsNode(container, node)) {
          return true;
        }
      }
      return false;
    }
    function purgeID(id) {
      delete nodeCache[id];
    }
    var deepestNodeSoFar = null;
    function findDeepestCachedAncestorImpl(ancestorID) {
      var ancestor = nodeCache[ancestorID];
      if (ancestor && isValid(ancestor, ancestorID)) {
        deepestNodeSoFar = ancestor;
      } else {
        return false;
      }
    }
    function findDeepestCachedAncestor(targetID) {
      deepestNodeSoFar = null;
      ReactInstanceHandles.traverseAncestors(targetID, findDeepestCachedAncestorImpl);
      var foundNode = deepestNodeSoFar;
      deepestNodeSoFar = null;
      return foundNode;
    }
    function mountComponentIntoNode(componentInstance, rootID, container, transaction, shouldReuseMarkup) {
      var markup = ReactReconciler.mountComponent(componentInstance, rootID, transaction, emptyObject);
      componentInstance._isTopLevel = true;
      ReactMount._mountImageIntoNode(markup, container, shouldReuseMarkup);
    }
    function batchedMountComponentIntoNode(componentInstance, rootID, container, shouldReuseMarkup) {
      var transaction = ReactUpdates.ReactReconcileTransaction.getPooled();
      transaction.perform(mountComponentIntoNode, null, componentInstance, rootID, container, transaction, shouldReuseMarkup);
      ReactUpdates.ReactReconcileTransaction.release(transaction);
    }
    var ReactMount = {
      _instancesByReactRootID: instancesByReactRootID,
      scrollMonitor: function(container, renderCallback) {
        renderCallback();
      },
      _updateRootComponent: function(prevComponent, nextElement, container, callback) {
        if ("production" !== process.env.NODE_ENV) {
          ReactElementValidator.checkAndWarnForMutatedProps(nextElement);
        }
        ReactMount.scrollMonitor(container, function() {
          ReactUpdateQueue.enqueueElementInternal(prevComponent, nextElement);
          if (callback) {
            ReactUpdateQueue.enqueueCallbackInternal(prevComponent, callback);
          }
        });
        if ("production" !== process.env.NODE_ENV) {
          rootElementsByReactRootID[getReactRootID(container)] = getReactRootElementInContainer(container);
        }
        return prevComponent;
      },
      _registerComponent: function(nextComponent, container) {
        ("production" !== process.env.NODE_ENV ? invariant(container && ((container.nodeType === ELEMENT_NODE_TYPE || container.nodeType === DOC_NODE_TYPE)), '_registerComponent(...): Target container is not a DOM element.') : invariant(container && ((container.nodeType === ELEMENT_NODE_TYPE || container.nodeType === DOC_NODE_TYPE))));
        ReactBrowserEventEmitter.ensureScrollValueMonitoring();
        var reactRootID = ReactMount.registerContainer(container);
        instancesByReactRootID[reactRootID] = nextComponent;
        return reactRootID;
      },
      _renderNewRootComponent: function(nextElement, container, shouldReuseMarkup) {
        ("production" !== process.env.NODE_ENV ? warning(ReactCurrentOwner.current == null, '_renderNewRootComponent(): Render methods should be a pure function ' + 'of props and state; triggering nested component updates from ' + 'render is not allowed. If necessary, trigger nested updates in ' + 'componentDidUpdate.') : null);
        var componentInstance = instantiateReactComponent(nextElement, null);
        var reactRootID = ReactMount._registerComponent(componentInstance, container);
        ReactUpdates.batchedUpdates(batchedMountComponentIntoNode, componentInstance, reactRootID, container, shouldReuseMarkup);
        if ("production" !== process.env.NODE_ENV) {
          rootElementsByReactRootID[reactRootID] = getReactRootElementInContainer(container);
        }
        return componentInstance;
      },
      render: function(nextElement, container, callback) {
        ("production" !== process.env.NODE_ENV ? invariant(ReactElement.isValidElement(nextElement), 'React.render(): Invalid component element.%s', (typeof nextElement === 'string' ? ' Instead of passing an element string, make sure to instantiate ' + 'it by passing it to React.createElement.' : typeof nextElement === 'function' ? ' Instead of passing a component class, make sure to instantiate ' + 'it by passing it to React.createElement.' : nextElement != null && nextElement.props !== undefined ? ' This may be caused by unintentionally loading two independent ' + 'copies of React.' : '')) : invariant(ReactElement.isValidElement(nextElement)));
        var prevComponent = instancesByReactRootID[getReactRootID(container)];
        if (prevComponent) {
          var prevElement = prevComponent._currentElement;
          if (shouldUpdateReactComponent(prevElement, nextElement)) {
            return ReactMount._updateRootComponent(prevComponent, nextElement, container, callback).getPublicInstance();
          } else {
            ReactMount.unmountComponentAtNode(container);
          }
        }
        var reactRootElement = getReactRootElementInContainer(container);
        var containerHasReactMarkup = reactRootElement && ReactMount.isRenderedByReact(reactRootElement);
        if ("production" !== process.env.NODE_ENV) {
          if (!containerHasReactMarkup || reactRootElement.nextSibling) {
            var rootElementSibling = reactRootElement;
            while (rootElementSibling) {
              if (ReactMount.isRenderedByReact(rootElementSibling)) {
                ("production" !== process.env.NODE_ENV ? warning(false, 'render(): Target node has markup rendered by React, but there ' + 'are unrelated nodes as well. This is most commonly caused by ' + 'white-space inserted around server-rendered markup.') : null);
                break;
              }
              rootElementSibling = rootElementSibling.nextSibling;
            }
          }
        }
        var shouldReuseMarkup = containerHasReactMarkup && !prevComponent;
        var component = ReactMount._renderNewRootComponent(nextElement, container, shouldReuseMarkup).getPublicInstance();
        if (callback) {
          callback.call(component);
        }
        return component;
      },
      constructAndRenderComponent: function(constructor, props, container) {
        var element = ReactElement.createElement(constructor, props);
        return ReactMount.render(element, container);
      },
      constructAndRenderComponentByID: function(constructor, props, id) {
        var domNode = document.getElementById(id);
        ("production" !== process.env.NODE_ENV ? invariant(domNode, 'Tried to get element with id of "%s" but it is not present on the page.', id) : invariant(domNode));
        return ReactMount.constructAndRenderComponent(constructor, props, domNode);
      },
      registerContainer: function(container) {
        var reactRootID = getReactRootID(container);
        if (reactRootID) {
          reactRootID = ReactInstanceHandles.getReactRootIDFromNodeID(reactRootID);
        }
        if (!reactRootID) {
          reactRootID = ReactInstanceHandles.createReactRootID();
        }
        containersByReactRootID[reactRootID] = container;
        return reactRootID;
      },
      unmountComponentAtNode: function(container) {
        ("production" !== process.env.NODE_ENV ? warning(ReactCurrentOwner.current == null, 'unmountComponentAtNode(): Render methods should be a pure function of ' + 'props and state; triggering nested component updates from render is ' + 'not allowed. If necessary, trigger nested updates in ' + 'componentDidUpdate.') : null);
        ("production" !== process.env.NODE_ENV ? invariant(container && ((container.nodeType === ELEMENT_NODE_TYPE || container.nodeType === DOC_NODE_TYPE)), 'unmountComponentAtNode(...): Target container is not a DOM element.') : invariant(container && ((container.nodeType === ELEMENT_NODE_TYPE || container.nodeType === DOC_NODE_TYPE))));
        var reactRootID = getReactRootID(container);
        var component = instancesByReactRootID[reactRootID];
        if (!component) {
          return false;
        }
        ReactMount.unmountComponentFromNode(component, container);
        delete instancesByReactRootID[reactRootID];
        delete containersByReactRootID[reactRootID];
        if ("production" !== process.env.NODE_ENV) {
          delete rootElementsByReactRootID[reactRootID];
        }
        return true;
      },
      unmountComponentFromNode: function(instance, container) {
        ReactReconciler.unmountComponent(instance);
        if (container.nodeType === DOC_NODE_TYPE) {
          container = container.documentElement;
        }
        while (container.lastChild) {
          container.removeChild(container.lastChild);
        }
      },
      findReactContainerForID: function(id) {
        var reactRootID = ReactInstanceHandles.getReactRootIDFromNodeID(id);
        var container = containersByReactRootID[reactRootID];
        if ("production" !== process.env.NODE_ENV) {
          var rootElement = rootElementsByReactRootID[reactRootID];
          if (rootElement && rootElement.parentNode !== container) {
            ("production" !== process.env.NODE_ENV ? invariant(internalGetID(rootElement) === reactRootID, 'ReactMount: Root element ID differed from reactRootID.') : invariant(internalGetID(rootElement) === reactRootID));
            var containerChild = container.firstChild;
            if (containerChild && reactRootID === internalGetID(containerChild)) {
              rootElementsByReactRootID[reactRootID] = containerChild;
            } else {
              ("production" !== process.env.NODE_ENV ? warning(false, 'ReactMount: Root element has been removed from its original ' + 'container. New container:', rootElement.parentNode) : null);
            }
          }
        }
        return container;
      },
      findReactNodeByID: function(id) {
        var reactRoot = ReactMount.findReactContainerForID(id);
        return ReactMount.findComponentRoot(reactRoot, id);
      },
      isRenderedByReact: function(node) {
        if (node.nodeType !== 1) {
          return false;
        }
        var id = ReactMount.getID(node);
        return id ? id.charAt(0) === SEPARATOR : false;
      },
      getFirstReactDOM: function(node) {
        var current = node;
        while (current && current.parentNode !== current) {
          if (ReactMount.isRenderedByReact(current)) {
            return current;
          }
          current = current.parentNode;
        }
        return null;
      },
      findComponentRoot: function(ancestorNode, targetID) {
        var firstChildren = findComponentRootReusableArray;
        var childIndex = 0;
        var deepestAncestor = findDeepestCachedAncestor(targetID) || ancestorNode;
        firstChildren[0] = deepestAncestor.firstChild;
        firstChildren.length = 1;
        while (childIndex < firstChildren.length) {
          var child = firstChildren[childIndex++];
          var targetChild;
          while (child) {
            var childID = ReactMount.getID(child);
            if (childID) {
              if (targetID === childID) {
                targetChild = child;
              } else if (ReactInstanceHandles.isAncestorIDOf(childID, targetID)) {
                firstChildren.length = childIndex = 0;
                firstChildren.push(child.firstChild);
              }
            } else {
              firstChildren.push(child.firstChild);
            }
            child = child.nextSibling;
          }
          if (targetChild) {
            firstChildren.length = 0;
            return targetChild;
          }
        }
        firstChildren.length = 0;
        ("production" !== process.env.NODE_ENV ? invariant(false, 'findComponentRoot(..., %s): Unable to find element. This probably ' + 'means the DOM was unexpectedly mutated (e.g., by the browser), ' + 'usually due to forgetting a <tbody> when using tables, nesting tags ' + 'like <form>, <p>, or <a>, or using non-SVG elements in an <svg> ' + 'parent. ' + 'Try inspecting the child nodes of the element with React ID `%s`.', targetID, ReactMount.getID(ancestorNode)) : invariant(false));
      },
      _mountImageIntoNode: function(markup, container, shouldReuseMarkup) {
        ("production" !== process.env.NODE_ENV ? invariant(container && ((container.nodeType === ELEMENT_NODE_TYPE || container.nodeType === DOC_NODE_TYPE)), 'mountComponentIntoNode(...): Target container is not valid.') : invariant(container && ((container.nodeType === ELEMENT_NODE_TYPE || container.nodeType === DOC_NODE_TYPE))));
        if (shouldReuseMarkup) {
          var rootElement = getReactRootElementInContainer(container);
          if (ReactMarkupChecksum.canReuseMarkup(markup, rootElement)) {
            return ;
          } else {
            var checksum = rootElement.getAttribute(ReactMarkupChecksum.CHECKSUM_ATTR_NAME);
            rootElement.removeAttribute(ReactMarkupChecksum.CHECKSUM_ATTR_NAME);
            var rootMarkup = rootElement.outerHTML;
            rootElement.setAttribute(ReactMarkupChecksum.CHECKSUM_ATTR_NAME, checksum);
            var diffIndex = firstDifferenceIndex(markup, rootMarkup);
            var difference = ' (client) ' + markup.substring(diffIndex - 20, diffIndex + 20) + '\n (server) ' + rootMarkup.substring(diffIndex - 20, diffIndex + 20);
            ("production" !== process.env.NODE_ENV ? invariant(container.nodeType !== DOC_NODE_TYPE, 'You\'re trying to render a component to the document using ' + 'server rendering but the checksum was invalid. This usually ' + 'means you rendered a different component type or props on ' + 'the client from the one on the server, or your render() ' + 'methods are impure. React cannot handle this case due to ' + 'cross-browser quirks by rendering at the document root. You ' + 'should look for environment dependent code in your components ' + 'and ensure the props are the same client and server side:\n%s', difference) : invariant(container.nodeType !== DOC_NODE_TYPE));
            if ("production" !== process.env.NODE_ENV) {
              ("production" !== process.env.NODE_ENV ? warning(false, 'React attempted to reuse markup in a container but the ' + 'checksum was invalid. This generally means that you are ' + 'using server rendering and the markup generated on the ' + 'server was not what the client was expecting. React injected ' + 'new markup to compensate which works but you have lost many ' + 'of the benefits of server rendering. Instead, figure out ' + 'why the markup being generated is different on the client ' + 'or server:\n%s', difference) : null);
            }
          }
        }
        ("production" !== process.env.NODE_ENV ? invariant(container.nodeType !== DOC_NODE_TYPE, 'You\'re trying to render a component to the document but ' + 'you didn\'t use server rendering. We can\'t do this ' + 'without using server rendering due to cross-browser quirks. ' + 'See React.renderToString() for server rendering.') : invariant(container.nodeType !== DOC_NODE_TYPE));
        setInnerHTML(container, markup);
      },
      getReactRootID: getReactRootID,
      getID: getID,
      setID: setID,
      getNode: getNode,
      getNodeFromInstance: getNodeFromInstance,
      purgeID: purgeID
    };
    ReactPerf.measureMethods(ReactMount, 'ReactMount', {
      _renderNewRootComponent: '_renderNewRootComponent',
      _mountImageIntoNode: '_mountImageIntoNode'
    });
    module.exports = ReactMount;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOMComponent", ["npm:react@0.13.3/lib/CSSPropertyOperations", "npm:react@0.13.3/lib/DOMProperty", "npm:react@0.13.3/lib/DOMPropertyOperations", "npm:react@0.13.3/lib/ReactBrowserEventEmitter", "npm:react@0.13.3/lib/ReactComponentBrowserEnvironment", "npm:react@0.13.3/lib/ReactMount", "npm:react@0.13.3/lib/ReactMultiChild", "npm:react@0.13.3/lib/ReactPerf", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/escapeTextContentForBrowser", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/isEventSupported", "npm:react@0.13.3/lib/keyOf", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var CSSPropertyOperations = require("npm:react@0.13.3/lib/CSSPropertyOperations");
    var DOMProperty = require("npm:react@0.13.3/lib/DOMProperty");
    var DOMPropertyOperations = require("npm:react@0.13.3/lib/DOMPropertyOperations");
    var ReactBrowserEventEmitter = require("npm:react@0.13.3/lib/ReactBrowserEventEmitter");
    var ReactComponentBrowserEnvironment = require("npm:react@0.13.3/lib/ReactComponentBrowserEnvironment");
    var ReactMount = require("npm:react@0.13.3/lib/ReactMount");
    var ReactMultiChild = require("npm:react@0.13.3/lib/ReactMultiChild");
    var ReactPerf = require("npm:react@0.13.3/lib/ReactPerf");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var escapeTextContentForBrowser = require("npm:react@0.13.3/lib/escapeTextContentForBrowser");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var isEventSupported = require("npm:react@0.13.3/lib/isEventSupported");
    var keyOf = require("npm:react@0.13.3/lib/keyOf");
    var warning = require("npm:react@0.13.3/lib/warning");
    var deleteListener = ReactBrowserEventEmitter.deleteListener;
    var listenTo = ReactBrowserEventEmitter.listenTo;
    var registrationNameModules = ReactBrowserEventEmitter.registrationNameModules;
    var CONTENT_TYPES = {
      'string': true,
      'number': true
    };
    var STYLE = keyOf({style: null});
    var ELEMENT_NODE_TYPE = 1;
    var BackendIDOperations = null;
    function assertValidProps(props) {
      if (!props) {
        return ;
      }
      if (props.dangerouslySetInnerHTML != null) {
        ("production" !== process.env.NODE_ENV ? invariant(props.children == null, 'Can only set one of `children` or `props.dangerouslySetInnerHTML`.') : invariant(props.children == null));
        ("production" !== process.env.NODE_ENV ? invariant(typeof props.dangerouslySetInnerHTML === 'object' && '__html' in props.dangerouslySetInnerHTML, '`props.dangerouslySetInnerHTML` must be in the form `{__html: ...}`. ' + 'Please visit https://fb.me/react-invariant-dangerously-set-inner-html ' + 'for more information.') : invariant(typeof props.dangerouslySetInnerHTML === 'object' && '__html' in props.dangerouslySetInnerHTML));
      }
      if ("production" !== process.env.NODE_ENV) {
        ("production" !== process.env.NODE_ENV ? warning(props.innerHTML == null, 'Directly setting property `innerHTML` is not permitted. ' + 'For more information, lookup documentation on `dangerouslySetInnerHTML`.') : null);
        ("production" !== process.env.NODE_ENV ? warning(!props.contentEditable || props.children == null, 'A component is `contentEditable` and contains `children` managed by ' + 'React. It is now your responsibility to guarantee that none of ' + 'those nodes are unexpectedly modified or duplicated. This is ' + 'probably not intentional.') : null);
      }
      ("production" !== process.env.NODE_ENV ? invariant(props.style == null || typeof props.style === 'object', 'The `style` prop expects a mapping from style properties to values, ' + 'not a string. For example, style={{marginRight: spacing + \'em\'}} when ' + 'using JSX.') : invariant(props.style == null || typeof props.style === 'object'));
    }
    function putListener(id, registrationName, listener, transaction) {
      if ("production" !== process.env.NODE_ENV) {
        ("production" !== process.env.NODE_ENV ? warning(registrationName !== 'onScroll' || isEventSupported('scroll', true), 'This browser doesn\'t support the `onScroll` event') : null);
      }
      var container = ReactMount.findReactContainerForID(id);
      if (container) {
        var doc = container.nodeType === ELEMENT_NODE_TYPE ? container.ownerDocument : container;
        listenTo(registrationName, doc);
      }
      transaction.getPutListenerQueue().enqueuePutListener(id, registrationName, listener);
    }
    var omittedCloseTags = {
      'area': true,
      'base': true,
      'br': true,
      'col': true,
      'embed': true,
      'hr': true,
      'img': true,
      'input': true,
      'keygen': true,
      'link': true,
      'meta': true,
      'param': true,
      'source': true,
      'track': true,
      'wbr': true
    };
    var VALID_TAG_REGEX = /^[a-zA-Z][a-zA-Z:_\.\-\d]*$/;
    var validatedTagCache = {};
    var hasOwnProperty = {}.hasOwnProperty;
    function validateDangerousTag(tag) {
      if (!hasOwnProperty.call(validatedTagCache, tag)) {
        ("production" !== process.env.NODE_ENV ? invariant(VALID_TAG_REGEX.test(tag), 'Invalid tag: %s', tag) : invariant(VALID_TAG_REGEX.test(tag)));
        validatedTagCache[tag] = true;
      }
    }
    function ReactDOMComponent(tag) {
      validateDangerousTag(tag);
      this._tag = tag;
      this._renderedChildren = null;
      this._previousStyleCopy = null;
      this._rootNodeID = null;
    }
    ReactDOMComponent.displayName = 'ReactDOMComponent';
    ReactDOMComponent.Mixin = {
      construct: function(element) {
        this._currentElement = element;
      },
      mountComponent: function(rootID, transaction, context) {
        this._rootNodeID = rootID;
        assertValidProps(this._currentElement.props);
        var closeTag = omittedCloseTags[this._tag] ? '' : '</' + this._tag + '>';
        return (this._createOpenTagMarkupAndPutListeners(transaction) + this._createContentMarkup(transaction, context) + closeTag);
      },
      _createOpenTagMarkupAndPutListeners: function(transaction) {
        var props = this._currentElement.props;
        var ret = '<' + this._tag;
        for (var propKey in props) {
          if (!props.hasOwnProperty(propKey)) {
            continue;
          }
          var propValue = props[propKey];
          if (propValue == null) {
            continue;
          }
          if (registrationNameModules.hasOwnProperty(propKey)) {
            putListener(this._rootNodeID, propKey, propValue, transaction);
          } else {
            if (propKey === STYLE) {
              if (propValue) {
                propValue = this._previousStyleCopy = assign({}, props.style);
              }
              propValue = CSSPropertyOperations.createMarkupForStyles(propValue);
            }
            var markup = DOMPropertyOperations.createMarkupForProperty(propKey, propValue);
            if (markup) {
              ret += ' ' + markup;
            }
          }
        }
        if (transaction.renderToStaticMarkup) {
          return ret + '>';
        }
        var markupForID = DOMPropertyOperations.createMarkupForID(this._rootNodeID);
        return ret + ' ' + markupForID + '>';
      },
      _createContentMarkup: function(transaction, context) {
        var prefix = '';
        if (this._tag === 'listing' || this._tag === 'pre' || this._tag === 'textarea') {
          prefix = '\n';
        }
        var props = this._currentElement.props;
        var innerHTML = props.dangerouslySetInnerHTML;
        if (innerHTML != null) {
          if (innerHTML.__html != null) {
            return prefix + innerHTML.__html;
          }
        } else {
          var contentToUse = CONTENT_TYPES[typeof props.children] ? props.children : null;
          var childrenToUse = contentToUse != null ? null : props.children;
          if (contentToUse != null) {
            return prefix + escapeTextContentForBrowser(contentToUse);
          } else if (childrenToUse != null) {
            var mountImages = this.mountChildren(childrenToUse, transaction, context);
            return prefix + mountImages.join('');
          }
        }
        return prefix;
      },
      receiveComponent: function(nextElement, transaction, context) {
        var prevElement = this._currentElement;
        this._currentElement = nextElement;
        this.updateComponent(transaction, prevElement, nextElement, context);
      },
      updateComponent: function(transaction, prevElement, nextElement, context) {
        assertValidProps(this._currentElement.props);
        this._updateDOMProperties(prevElement.props, transaction);
        this._updateDOMChildren(prevElement.props, transaction, context);
      },
      _updateDOMProperties: function(lastProps, transaction) {
        var nextProps = this._currentElement.props;
        var propKey;
        var styleName;
        var styleUpdates;
        for (propKey in lastProps) {
          if (nextProps.hasOwnProperty(propKey) || !lastProps.hasOwnProperty(propKey)) {
            continue;
          }
          if (propKey === STYLE) {
            var lastStyle = this._previousStyleCopy;
            for (styleName in lastStyle) {
              if (lastStyle.hasOwnProperty(styleName)) {
                styleUpdates = styleUpdates || {};
                styleUpdates[styleName] = '';
              }
            }
            this._previousStyleCopy = null;
          } else if (registrationNameModules.hasOwnProperty(propKey)) {
            deleteListener(this._rootNodeID, propKey);
          } else if (DOMProperty.isStandardName[propKey] || DOMProperty.isCustomAttribute(propKey)) {
            BackendIDOperations.deletePropertyByID(this._rootNodeID, propKey);
          }
        }
        for (propKey in nextProps) {
          var nextProp = nextProps[propKey];
          var lastProp = propKey === STYLE ? this._previousStyleCopy : lastProps[propKey];
          if (!nextProps.hasOwnProperty(propKey) || nextProp === lastProp) {
            continue;
          }
          if (propKey === STYLE) {
            if (nextProp) {
              nextProp = this._previousStyleCopy = assign({}, nextProp);
            } else {
              this._previousStyleCopy = null;
            }
            if (lastProp) {
              for (styleName in lastProp) {
                if (lastProp.hasOwnProperty(styleName) && (!nextProp || !nextProp.hasOwnProperty(styleName))) {
                  styleUpdates = styleUpdates || {};
                  styleUpdates[styleName] = '';
                }
              }
              for (styleName in nextProp) {
                if (nextProp.hasOwnProperty(styleName) && lastProp[styleName] !== nextProp[styleName]) {
                  styleUpdates = styleUpdates || {};
                  styleUpdates[styleName] = nextProp[styleName];
                }
              }
            } else {
              styleUpdates = nextProp;
            }
          } else if (registrationNameModules.hasOwnProperty(propKey)) {
            putListener(this._rootNodeID, propKey, nextProp, transaction);
          } else if (DOMProperty.isStandardName[propKey] || DOMProperty.isCustomAttribute(propKey)) {
            BackendIDOperations.updatePropertyByID(this._rootNodeID, propKey, nextProp);
          }
        }
        if (styleUpdates) {
          BackendIDOperations.updateStylesByID(this._rootNodeID, styleUpdates);
        }
      },
      _updateDOMChildren: function(lastProps, transaction, context) {
        var nextProps = this._currentElement.props;
        var lastContent = CONTENT_TYPES[typeof lastProps.children] ? lastProps.children : null;
        var nextContent = CONTENT_TYPES[typeof nextProps.children] ? nextProps.children : null;
        var lastHtml = lastProps.dangerouslySetInnerHTML && lastProps.dangerouslySetInnerHTML.__html;
        var nextHtml = nextProps.dangerouslySetInnerHTML && nextProps.dangerouslySetInnerHTML.__html;
        var lastChildren = lastContent != null ? null : lastProps.children;
        var nextChildren = nextContent != null ? null : nextProps.children;
        var lastHasContentOrHtml = lastContent != null || lastHtml != null;
        var nextHasContentOrHtml = nextContent != null || nextHtml != null;
        if (lastChildren != null && nextChildren == null) {
          this.updateChildren(null, transaction, context);
        } else if (lastHasContentOrHtml && !nextHasContentOrHtml) {
          this.updateTextContent('');
        }
        if (nextContent != null) {
          if (lastContent !== nextContent) {
            this.updateTextContent('' + nextContent);
          }
        } else if (nextHtml != null) {
          if (lastHtml !== nextHtml) {
            BackendIDOperations.updateInnerHTMLByID(this._rootNodeID, nextHtml);
          }
        } else if (nextChildren != null) {
          this.updateChildren(nextChildren, transaction, context);
        }
      },
      unmountComponent: function() {
        this.unmountChildren();
        ReactBrowserEventEmitter.deleteAllListeners(this._rootNodeID);
        ReactComponentBrowserEnvironment.unmountIDFromEnvironment(this._rootNodeID);
        this._rootNodeID = null;
      }
    };
    ReactPerf.measureMethods(ReactDOMComponent, 'ReactDOMComponent', {
      mountComponent: 'mountComponent',
      updateComponent: 'updateComponent'
    });
    assign(ReactDOMComponent.prototype, ReactDOMComponent.Mixin, ReactMultiChild.Mixin);
    ReactDOMComponent.injection = {injectIDOperations: function(IDOperations) {
        ReactDOMComponent.BackendIDOperations = BackendIDOperations = IDOperations;
      }};
    module.exports = ReactDOMComponent;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/BeforeInputEventPlugin", ["npm:react@0.13.3/lib/EventConstants", "npm:react@0.13.3/lib/EventPropagators", "npm:react@0.13.3/lib/ExecutionEnvironment", "npm:react@0.13.3/lib/FallbackCompositionState", "npm:react@0.13.3/lib/SyntheticCompositionEvent", "npm:react@0.13.3/lib/SyntheticInputEvent", "npm:react@0.13.3/lib/keyOf"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var EventConstants = require("npm:react@0.13.3/lib/EventConstants");
  var EventPropagators = require("npm:react@0.13.3/lib/EventPropagators");
  var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
  var FallbackCompositionState = require("npm:react@0.13.3/lib/FallbackCompositionState");
  var SyntheticCompositionEvent = require("npm:react@0.13.3/lib/SyntheticCompositionEvent");
  var SyntheticInputEvent = require("npm:react@0.13.3/lib/SyntheticInputEvent");
  var keyOf = require("npm:react@0.13.3/lib/keyOf");
  var END_KEYCODES = [9, 13, 27, 32];
  var START_KEYCODE = 229;
  var canUseCompositionEvent = (ExecutionEnvironment.canUseDOM && 'CompositionEvent' in window);
  var documentMode = null;
  if (ExecutionEnvironment.canUseDOM && 'documentMode' in document) {
    documentMode = document.documentMode;
  }
  var canUseTextInputEvent = (ExecutionEnvironment.canUseDOM && 'TextEvent' in window && !documentMode && !isPresto());
  var useFallbackCompositionData = (ExecutionEnvironment.canUseDOM && ((!canUseCompositionEvent || documentMode && documentMode > 8 && documentMode <= 11)));
  function isPresto() {
    var opera = window.opera;
    return (typeof opera === 'object' && typeof opera.version === 'function' && parseInt(opera.version(), 10) <= 12);
  }
  var SPACEBAR_CODE = 32;
  var SPACEBAR_CHAR = String.fromCharCode(SPACEBAR_CODE);
  var topLevelTypes = EventConstants.topLevelTypes;
  var eventTypes = {
    beforeInput: {
      phasedRegistrationNames: {
        bubbled: keyOf({onBeforeInput: null}),
        captured: keyOf({onBeforeInputCapture: null})
      },
      dependencies: [topLevelTypes.topCompositionEnd, topLevelTypes.topKeyPress, topLevelTypes.topTextInput, topLevelTypes.topPaste]
    },
    compositionEnd: {
      phasedRegistrationNames: {
        bubbled: keyOf({onCompositionEnd: null}),
        captured: keyOf({onCompositionEndCapture: null})
      },
      dependencies: [topLevelTypes.topBlur, topLevelTypes.topCompositionEnd, topLevelTypes.topKeyDown, topLevelTypes.topKeyPress, topLevelTypes.topKeyUp, topLevelTypes.topMouseDown]
    },
    compositionStart: {
      phasedRegistrationNames: {
        bubbled: keyOf({onCompositionStart: null}),
        captured: keyOf({onCompositionStartCapture: null})
      },
      dependencies: [topLevelTypes.topBlur, topLevelTypes.topCompositionStart, topLevelTypes.topKeyDown, topLevelTypes.topKeyPress, topLevelTypes.topKeyUp, topLevelTypes.topMouseDown]
    },
    compositionUpdate: {
      phasedRegistrationNames: {
        bubbled: keyOf({onCompositionUpdate: null}),
        captured: keyOf({onCompositionUpdateCapture: null})
      },
      dependencies: [topLevelTypes.topBlur, topLevelTypes.topCompositionUpdate, topLevelTypes.topKeyDown, topLevelTypes.topKeyPress, topLevelTypes.topKeyUp, topLevelTypes.topMouseDown]
    }
  };
  var hasSpaceKeypress = false;
  function isKeypressCommand(nativeEvent) {
    return ((nativeEvent.ctrlKey || nativeEvent.altKey || nativeEvent.metaKey) && !(nativeEvent.ctrlKey && nativeEvent.altKey));
  }
  function getCompositionEventType(topLevelType) {
    switch (topLevelType) {
      case topLevelTypes.topCompositionStart:
        return eventTypes.compositionStart;
      case topLevelTypes.topCompositionEnd:
        return eventTypes.compositionEnd;
      case topLevelTypes.topCompositionUpdate:
        return eventTypes.compositionUpdate;
    }
  }
  function isFallbackCompositionStart(topLevelType, nativeEvent) {
    return (topLevelType === topLevelTypes.topKeyDown && nativeEvent.keyCode === START_KEYCODE);
  }
  function isFallbackCompositionEnd(topLevelType, nativeEvent) {
    switch (topLevelType) {
      case topLevelTypes.topKeyUp:
        return (END_KEYCODES.indexOf(nativeEvent.keyCode) !== -1);
      case topLevelTypes.topKeyDown:
        return (nativeEvent.keyCode !== START_KEYCODE);
      case topLevelTypes.topKeyPress:
      case topLevelTypes.topMouseDown:
      case topLevelTypes.topBlur:
        return true;
      default:
        return false;
    }
  }
  function getDataFromCustomEvent(nativeEvent) {
    var detail = nativeEvent.detail;
    if (typeof detail === 'object' && 'data' in detail) {
      return detail.data;
    }
    return null;
  }
  var currentComposition = null;
  function extractCompositionEvent(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent) {
    var eventType;
    var fallbackData;
    if (canUseCompositionEvent) {
      eventType = getCompositionEventType(topLevelType);
    } else if (!currentComposition) {
      if (isFallbackCompositionStart(topLevelType, nativeEvent)) {
        eventType = eventTypes.compositionStart;
      }
    } else if (isFallbackCompositionEnd(topLevelType, nativeEvent)) {
      eventType = eventTypes.compositionEnd;
    }
    if (!eventType) {
      return null;
    }
    if (useFallbackCompositionData) {
      if (!currentComposition && eventType === eventTypes.compositionStart) {
        currentComposition = FallbackCompositionState.getPooled(topLevelTarget);
      } else if (eventType === eventTypes.compositionEnd) {
        if (currentComposition) {
          fallbackData = currentComposition.getData();
        }
      }
    }
    var event = SyntheticCompositionEvent.getPooled(eventType, topLevelTargetID, nativeEvent);
    if (fallbackData) {
      event.data = fallbackData;
    } else {
      var customData = getDataFromCustomEvent(nativeEvent);
      if (customData !== null) {
        event.data = customData;
      }
    }
    EventPropagators.accumulateTwoPhaseDispatches(event);
    return event;
  }
  function getNativeBeforeInputChars(topLevelType, nativeEvent) {
    switch (topLevelType) {
      case topLevelTypes.topCompositionEnd:
        return getDataFromCustomEvent(nativeEvent);
      case topLevelTypes.topKeyPress:
        var which = nativeEvent.which;
        if (which !== SPACEBAR_CODE) {
          return null;
        }
        hasSpaceKeypress = true;
        return SPACEBAR_CHAR;
      case topLevelTypes.topTextInput:
        var chars = nativeEvent.data;
        if (chars === SPACEBAR_CHAR && hasSpaceKeypress) {
          return null;
        }
        return chars;
      default:
        return null;
    }
  }
  function getFallbackBeforeInputChars(topLevelType, nativeEvent) {
    if (currentComposition) {
      if (topLevelType === topLevelTypes.topCompositionEnd || isFallbackCompositionEnd(topLevelType, nativeEvent)) {
        var chars = currentComposition.getData();
        FallbackCompositionState.release(currentComposition);
        currentComposition = null;
        return chars;
      }
      return null;
    }
    switch (topLevelType) {
      case topLevelTypes.topPaste:
        return null;
      case topLevelTypes.topKeyPress:
        if (nativeEvent.which && !isKeypressCommand(nativeEvent)) {
          return String.fromCharCode(nativeEvent.which);
        }
        return null;
      case topLevelTypes.topCompositionEnd:
        return useFallbackCompositionData ? null : nativeEvent.data;
      default:
        return null;
    }
  }
  function extractBeforeInputEvent(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent) {
    var chars;
    if (canUseTextInputEvent) {
      chars = getNativeBeforeInputChars(topLevelType, nativeEvent);
    } else {
      chars = getFallbackBeforeInputChars(topLevelType, nativeEvent);
    }
    if (!chars) {
      return null;
    }
    var event = SyntheticInputEvent.getPooled(eventTypes.beforeInput, topLevelTargetID, nativeEvent);
    event.data = chars;
    EventPropagators.accumulateTwoPhaseDispatches(event);
    return event;
  }
  var BeforeInputEventPlugin = {
    eventTypes: eventTypes,
    extractEvents: function(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent) {
      return [extractCompositionEvent(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent), extractBeforeInputEvent(topLevelType, topLevelTarget, topLevelTargetID, nativeEvent)];
    }
  };
  module.exports = BeforeInputEventPlugin;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactReconcileTransaction", ["npm:react@0.13.3/lib/CallbackQueue", "npm:react@0.13.3/lib/PooledClass", "npm:react@0.13.3/lib/ReactBrowserEventEmitter", "npm:react@0.13.3/lib/ReactInputSelection", "npm:react@0.13.3/lib/ReactPutListenerQueue", "npm:react@0.13.3/lib/Transaction", "npm:react@0.13.3/lib/Object.assign"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var CallbackQueue = require("npm:react@0.13.3/lib/CallbackQueue");
  var PooledClass = require("npm:react@0.13.3/lib/PooledClass");
  var ReactBrowserEventEmitter = require("npm:react@0.13.3/lib/ReactBrowserEventEmitter");
  var ReactInputSelection = require("npm:react@0.13.3/lib/ReactInputSelection");
  var ReactPutListenerQueue = require("npm:react@0.13.3/lib/ReactPutListenerQueue");
  var Transaction = require("npm:react@0.13.3/lib/Transaction");
  var assign = require("npm:react@0.13.3/lib/Object.assign");
  var SELECTION_RESTORATION = {
    initialize: ReactInputSelection.getSelectionInformation,
    close: ReactInputSelection.restoreSelection
  };
  var EVENT_SUPPRESSION = {
    initialize: function() {
      var currentlyEnabled = ReactBrowserEventEmitter.isEnabled();
      ReactBrowserEventEmitter.setEnabled(false);
      return currentlyEnabled;
    },
    close: function(previouslyEnabled) {
      ReactBrowserEventEmitter.setEnabled(previouslyEnabled);
    }
  };
  var ON_DOM_READY_QUEUEING = {
    initialize: function() {
      this.reactMountReady.reset();
    },
    close: function() {
      this.reactMountReady.notifyAll();
    }
  };
  var PUT_LISTENER_QUEUEING = {
    initialize: function() {
      this.putListenerQueue.reset();
    },
    close: function() {
      this.putListenerQueue.putListeners();
    }
  };
  var TRANSACTION_WRAPPERS = [PUT_LISTENER_QUEUEING, SELECTION_RESTORATION, EVENT_SUPPRESSION, ON_DOM_READY_QUEUEING];
  function ReactReconcileTransaction() {
    this.reinitializeTransaction();
    this.renderToStaticMarkup = false;
    this.reactMountReady = CallbackQueue.getPooled(null);
    this.putListenerQueue = ReactPutListenerQueue.getPooled();
  }
  var Mixin = {
    getTransactionWrappers: function() {
      return TRANSACTION_WRAPPERS;
    },
    getReactMountReady: function() {
      return this.reactMountReady;
    },
    getPutListenerQueue: function() {
      return this.putListenerQueue;
    },
    destructor: function() {
      CallbackQueue.release(this.reactMountReady);
      this.reactMountReady = null;
      ReactPutListenerQueue.release(this.putListenerQueue);
      this.putListenerQueue = null;
    }
  };
  assign(ReactReconcileTransaction.prototype, Transaction.Mixin, Mixin);
  PooledClass.addPoolingTo(ReactReconcileTransaction);
  module.exports = ReactReconcileTransaction;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseIsEqual", ["npm:lodash@3.9.1/internal/baseIsEqualDeep", "npm:lodash@3.9.1/lang/isObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseIsEqualDeep = require("npm:lodash@3.9.1/internal/baseIsEqualDeep"),
      isObject = require("npm:lodash@3.9.1/lang/isObject");
  function baseIsEqual(value, other, customizer, isLoose, stackA, stackB) {
    if (value === other) {
      return true;
    }
    if (value == null || other == null || (!isObject(value) && !isObject(other))) {
      return value !== value && other !== other;
    }
    return baseIsEqualDeep(value, other, baseIsEqual, customizer, isLoose, stackA, stackB);
  }
  module.exports = baseIsEqual;
  global.define = __define;
  return module.exports;
});



System.register("npm:color-string@0.3.0", ["npm:color-string@0.3.0/color-string"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:color-string@0.3.0/color-string");
  global.define = __define;
  return module.exports;
});



System.register("npm:flux@2.0.3", ["npm:flux@2.0.3/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:flux@2.0.3/index");
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseToString", ["github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    function baseToString(value) {
      if (typeof value == 'string') {
        return value;
      }
      return value == null ? '' : (value + '');
    }
    module.exports = baseToString;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseForIn", ["npm:lodash@3.9.1/internal/baseFor", "npm:lodash@3.9.1/object/keysIn"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseFor = require("npm:lodash@3.9.1/internal/baseFor"),
      keysIn = require("npm:lodash@3.9.1/object/keysIn");
  function baseForIn(object, iteratee) {
    return baseFor(object, iteratee, keysIn);
  }
  module.exports = baseForIn;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactFragment", ["npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var warning = require("npm:react@0.13.3/lib/warning");
    if ("production" !== process.env.NODE_ENV) {
      var fragmentKey = '_reactFragment';
      var didWarnKey = '_reactDidWarn';
      var canWarnForReactFragment = false;
      try {
        var dummy = function() {
          return 1;
        };
        Object.defineProperty({}, fragmentKey, {
          enumerable: false,
          value: true
        });
        Object.defineProperty({}, 'key', {
          enumerable: true,
          get: dummy
        });
        canWarnForReactFragment = true;
      } catch (x) {}
      var proxyPropertyAccessWithWarning = function(obj, key) {
        Object.defineProperty(obj, key, {
          enumerable: true,
          get: function() {
            ("production" !== process.env.NODE_ENV ? warning(this[didWarnKey], 'A ReactFragment is an opaque type. Accessing any of its ' + 'properties is deprecated. Pass it to one of the React.Children ' + 'helpers.') : null);
            this[didWarnKey] = true;
            return this[fragmentKey][key];
          },
          set: function(value) {
            ("production" !== process.env.NODE_ENV ? warning(this[didWarnKey], 'A ReactFragment is an immutable opaque type. Mutating its ' + 'properties is deprecated.') : null);
            this[didWarnKey] = true;
            this[fragmentKey][key] = value;
          }
        });
      };
      var issuedWarnings = {};
      var didWarnForFragment = function(fragment) {
        var fragmentCacheKey = '';
        for (var key in fragment) {
          fragmentCacheKey += key + ':' + (typeof fragment[key]) + ',';
        }
        var alreadyWarnedOnce = !!issuedWarnings[fragmentCacheKey];
        issuedWarnings[fragmentCacheKey] = true;
        return alreadyWarnedOnce;
      };
    }
    var ReactFragment = {
      create: function(object) {
        if ("production" !== process.env.NODE_ENV) {
          if (typeof object !== 'object' || !object || Array.isArray(object)) {
            ("production" !== process.env.NODE_ENV ? warning(false, 'React.addons.createFragment only accepts a single object.', object) : null);
            return object;
          }
          if (ReactElement.isValidElement(object)) {
            ("production" !== process.env.NODE_ENV ? warning(false, 'React.addons.createFragment does not accept a ReactElement ' + 'without a wrapper object.') : null);
            return object;
          }
          if (canWarnForReactFragment) {
            var proxy = {};
            Object.defineProperty(proxy, fragmentKey, {
              enumerable: false,
              value: object
            });
            Object.defineProperty(proxy, didWarnKey, {
              writable: true,
              enumerable: false,
              value: false
            });
            for (var key in object) {
              proxyPropertyAccessWithWarning(proxy, key);
            }
            Object.preventExtensions(proxy);
            return proxy;
          }
        }
        return object;
      },
      extract: function(fragment) {
        if ("production" !== process.env.NODE_ENV) {
          if (canWarnForReactFragment) {
            if (!fragment[fragmentKey]) {
              ("production" !== process.env.NODE_ENV ? warning(didWarnForFragment(fragment), 'Any use of a keyed object should be wrapped in ' + 'React.addons.createFragment(object) before being passed as a ' + 'child.') : null);
              return fragment;
            }
            return fragment[fragmentKey];
          }
        }
        return fragment;
      },
      extractIfFragment: function(fragment) {
        if ("production" !== process.env.NODE_ENV) {
          if (canWarnForReactFragment) {
            if (fragment[fragmentKey]) {
              return fragment[fragmentKey];
            }
            for (var key in fragment) {
              if (fragment.hasOwnProperty(key) && ReactElement.isValidElement(fragment[key])) {
                return ReactFragment.extract(fragment);
              }
            }
          }
        }
        return fragment;
      }
    };
    module.exports = ReactFragment;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactUpdateQueue", ["npm:react@0.13.3/lib/ReactLifeCycle", "npm:react@0.13.3/lib/ReactCurrentOwner", "npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactInstanceMap", "npm:react@0.13.3/lib/ReactUpdates", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactLifeCycle = require("npm:react@0.13.3/lib/ReactLifeCycle");
    var ReactCurrentOwner = require("npm:react@0.13.3/lib/ReactCurrentOwner");
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactInstanceMap = require("npm:react@0.13.3/lib/ReactInstanceMap");
    var ReactUpdates = require("npm:react@0.13.3/lib/ReactUpdates");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var warning = require("npm:react@0.13.3/lib/warning");
    function enqueueUpdate(internalInstance) {
      if (internalInstance !== ReactLifeCycle.currentlyMountingInstance) {
        ReactUpdates.enqueueUpdate(internalInstance);
      }
    }
    function getInternalInstanceReadyForUpdate(publicInstance, callerName) {
      ("production" !== process.env.NODE_ENV ? invariant(ReactCurrentOwner.current == null, '%s(...): Cannot update during an existing state transition ' + '(such as within `render`). Render methods should be a pure function ' + 'of props and state.', callerName) : invariant(ReactCurrentOwner.current == null));
      var internalInstance = ReactInstanceMap.get(publicInstance);
      if (!internalInstance) {
        if ("production" !== process.env.NODE_ENV) {
          ("production" !== process.env.NODE_ENV ? warning(!callerName, '%s(...): Can only update a mounted or mounting component. ' + 'This usually means you called %s() on an unmounted ' + 'component. This is a no-op.', callerName, callerName) : null);
        }
        return null;
      }
      if (internalInstance === ReactLifeCycle.currentlyUnmountingInstance) {
        return null;
      }
      return internalInstance;
    }
    var ReactUpdateQueue = {
      enqueueCallback: function(publicInstance, callback) {
        ("production" !== process.env.NODE_ENV ? invariant(typeof callback === 'function', 'enqueueCallback(...): You called `setProps`, `replaceProps`, ' + '`setState`, `replaceState`, or `forceUpdate` with a callback that ' + 'isn\'t callable.') : invariant(typeof callback === 'function'));
        var internalInstance = getInternalInstanceReadyForUpdate(publicInstance);
        if (!internalInstance || internalInstance === ReactLifeCycle.currentlyMountingInstance) {
          return null;
        }
        if (internalInstance._pendingCallbacks) {
          internalInstance._pendingCallbacks.push(callback);
        } else {
          internalInstance._pendingCallbacks = [callback];
        }
        enqueueUpdate(internalInstance);
      },
      enqueueCallbackInternal: function(internalInstance, callback) {
        ("production" !== process.env.NODE_ENV ? invariant(typeof callback === 'function', 'enqueueCallback(...): You called `setProps`, `replaceProps`, ' + '`setState`, `replaceState`, or `forceUpdate` with a callback that ' + 'isn\'t callable.') : invariant(typeof callback === 'function'));
        if (internalInstance._pendingCallbacks) {
          internalInstance._pendingCallbacks.push(callback);
        } else {
          internalInstance._pendingCallbacks = [callback];
        }
        enqueueUpdate(internalInstance);
      },
      enqueueForceUpdate: function(publicInstance) {
        var internalInstance = getInternalInstanceReadyForUpdate(publicInstance, 'forceUpdate');
        if (!internalInstance) {
          return ;
        }
        internalInstance._pendingForceUpdate = true;
        enqueueUpdate(internalInstance);
      },
      enqueueReplaceState: function(publicInstance, completeState) {
        var internalInstance = getInternalInstanceReadyForUpdate(publicInstance, 'replaceState');
        if (!internalInstance) {
          return ;
        }
        internalInstance._pendingStateQueue = [completeState];
        internalInstance._pendingReplaceState = true;
        enqueueUpdate(internalInstance);
      },
      enqueueSetState: function(publicInstance, partialState) {
        var internalInstance = getInternalInstanceReadyForUpdate(publicInstance, 'setState');
        if (!internalInstance) {
          return ;
        }
        var queue = internalInstance._pendingStateQueue || (internalInstance._pendingStateQueue = []);
        queue.push(partialState);
        enqueueUpdate(internalInstance);
      },
      enqueueSetProps: function(publicInstance, partialProps) {
        var internalInstance = getInternalInstanceReadyForUpdate(publicInstance, 'setProps');
        if (!internalInstance) {
          return ;
        }
        ("production" !== process.env.NODE_ENV ? invariant(internalInstance._isTopLevel, 'setProps(...): You called `setProps` on a ' + 'component with a parent. This is an anti-pattern since props will ' + 'get reactively updated when rendered. Instead, change the owner\'s ' + '`render` method to pass the correct value as props to the component ' + 'where it is created.') : invariant(internalInstance._isTopLevel));
        var element = internalInstance._pendingElement || internalInstance._currentElement;
        var props = assign({}, element.props, partialProps);
        internalInstance._pendingElement = ReactElement.cloneAndReplaceProps(element, props);
        enqueueUpdate(internalInstance);
      },
      enqueueReplaceProps: function(publicInstance, props) {
        var internalInstance = getInternalInstanceReadyForUpdate(publicInstance, 'replaceProps');
        if (!internalInstance) {
          return ;
        }
        ("production" !== process.env.NODE_ENV ? invariant(internalInstance._isTopLevel, 'replaceProps(...): You called `replaceProps` on a ' + 'component with a parent. This is an anti-pattern since props will ' + 'get reactively updated when rendered. Instead, change the owner\'s ' + '`render` method to pass the correct value as props to the component ' + 'where it is created.') : invariant(internalInstance._isTopLevel));
        var element = internalInstance._pendingElement || internalInstance._currentElement;
        internalInstance._pendingElement = ReactElement.cloneAndReplaceProps(element, props);
        enqueueUpdate(internalInstance);
      },
      enqueueElementInternal: function(internalInstance, newElement) {
        internalInstance._pendingElement = newElement;
        enqueueUpdate(internalInstance);
      }
    };
    module.exports = ReactUpdateQueue;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/DOMChildrenOperations", ["npm:react@0.13.3/lib/Danger", "npm:react@0.13.3/lib/ReactMultiChildUpdateTypes", "npm:react@0.13.3/lib/setTextContent", "npm:react@0.13.3/lib/invariant", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var Danger = require("npm:react@0.13.3/lib/Danger");
    var ReactMultiChildUpdateTypes = require("npm:react@0.13.3/lib/ReactMultiChildUpdateTypes");
    var setTextContent = require("npm:react@0.13.3/lib/setTextContent");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    function insertChildAt(parentNode, childNode, index) {
      parentNode.insertBefore(childNode, parentNode.childNodes[index] || null);
    }
    var DOMChildrenOperations = {
      dangerouslyReplaceNodeWithMarkup: Danger.dangerouslyReplaceNodeWithMarkup,
      updateTextContent: setTextContent,
      processUpdates: function(updates, markupList) {
        var update;
        var initialChildren = null;
        var updatedChildren = null;
        for (var i = 0; i < updates.length; i++) {
          update = updates[i];
          if (update.type === ReactMultiChildUpdateTypes.MOVE_EXISTING || update.type === ReactMultiChildUpdateTypes.REMOVE_NODE) {
            var updatedIndex = update.fromIndex;
            var updatedChild = update.parentNode.childNodes[updatedIndex];
            var parentID = update.parentID;
            ("production" !== process.env.NODE_ENV ? invariant(updatedChild, 'processUpdates(): Unable to find child %s of element. This ' + 'probably means the DOM was unexpectedly mutated (e.g., by the ' + 'browser), usually due to forgetting a <tbody> when using tables, ' + 'nesting tags like <form>, <p>, or <a>, or using non-SVG elements ' + 'in an <svg> parent. Try inspecting the child nodes of the element ' + 'with React ID `%s`.', updatedIndex, parentID) : invariant(updatedChild));
            initialChildren = initialChildren || {};
            initialChildren[parentID] = initialChildren[parentID] || [];
            initialChildren[parentID][updatedIndex] = updatedChild;
            updatedChildren = updatedChildren || [];
            updatedChildren.push(updatedChild);
          }
        }
        var renderedMarkup = Danger.dangerouslyRenderMarkup(markupList);
        if (updatedChildren) {
          for (var j = 0; j < updatedChildren.length; j++) {
            updatedChildren[j].parentNode.removeChild(updatedChildren[j]);
          }
        }
        for (var k = 0; k < updates.length; k++) {
          update = updates[k];
          switch (update.type) {
            case ReactMultiChildUpdateTypes.INSERT_MARKUP:
              insertChildAt(update.parentNode, renderedMarkup[update.markupIndex], update.toIndex);
              break;
            case ReactMultiChildUpdateTypes.MOVE_EXISTING:
              insertChildAt(update.parentNode, initialChildren[update.parentID][update.fromIndex], update.toIndex);
              break;
            case ReactMultiChildUpdateTypes.TEXT_CONTENT:
              setTextContent(update.parentNode, update.textContent);
              break;
            case ReactMultiChildUpdateTypes.REMOVE_NODE:
              break;
          }
        }
      }
    };
    module.exports = DOMChildrenOperations;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDefaultInjection", ["npm:react@0.13.3/lib/BeforeInputEventPlugin", "npm:react@0.13.3/lib/ChangeEventPlugin", "npm:react@0.13.3/lib/ClientReactRootIndex", "npm:react@0.13.3/lib/DefaultEventPluginOrder", "npm:react@0.13.3/lib/EnterLeaveEventPlugin", "npm:react@0.13.3/lib/ExecutionEnvironment", "npm:react@0.13.3/lib/HTMLDOMPropertyConfig", "npm:react@0.13.3/lib/MobileSafariClickEventPlugin", "npm:react@0.13.3/lib/ReactBrowserComponentMixin", "npm:react@0.13.3/lib/ReactClass", "npm:react@0.13.3/lib/ReactComponentBrowserEnvironment", "npm:react@0.13.3/lib/ReactDefaultBatchingStrategy", "npm:react@0.13.3/lib/ReactDOMComponent", "npm:react@0.13.3/lib/ReactDOMButton", "npm:react@0.13.3/lib/ReactDOMForm", "npm:react@0.13.3/lib/ReactDOMImg", "npm:react@0.13.3/lib/ReactDOMIDOperations", "npm:react@0.13.3/lib/ReactDOMIframe", "npm:react@0.13.3/lib/ReactDOMInput", "npm:react@0.13.3/lib/ReactDOMOption", "npm:react@0.13.3/lib/ReactDOMSelect", "npm:react@0.13.3/lib/ReactDOMTextarea", "npm:react@0.13.3/lib/ReactDOMTextComponent", "npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactEventListener", "npm:react@0.13.3/lib/ReactInjection", "npm:react@0.13.3/lib/ReactInstanceHandles", "npm:react@0.13.3/lib/ReactMount", "npm:react@0.13.3/lib/ReactReconcileTransaction", "npm:react@0.13.3/lib/SelectEventPlugin", "npm:react@0.13.3/lib/ServerReactRootIndex", "npm:react@0.13.3/lib/SimpleEventPlugin", "npm:react@0.13.3/lib/SVGDOMPropertyConfig", "npm:react@0.13.3/lib/createFullPageComponent", "npm:react@0.13.3/lib/ReactDefaultPerf", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var BeforeInputEventPlugin = require("npm:react@0.13.3/lib/BeforeInputEventPlugin");
    var ChangeEventPlugin = require("npm:react@0.13.3/lib/ChangeEventPlugin");
    var ClientReactRootIndex = require("npm:react@0.13.3/lib/ClientReactRootIndex");
    var DefaultEventPluginOrder = require("npm:react@0.13.3/lib/DefaultEventPluginOrder");
    var EnterLeaveEventPlugin = require("npm:react@0.13.3/lib/EnterLeaveEventPlugin");
    var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
    var HTMLDOMPropertyConfig = require("npm:react@0.13.3/lib/HTMLDOMPropertyConfig");
    var MobileSafariClickEventPlugin = require("npm:react@0.13.3/lib/MobileSafariClickEventPlugin");
    var ReactBrowserComponentMixin = require("npm:react@0.13.3/lib/ReactBrowserComponentMixin");
    var ReactClass = require("npm:react@0.13.3/lib/ReactClass");
    var ReactComponentBrowserEnvironment = require("npm:react@0.13.3/lib/ReactComponentBrowserEnvironment");
    var ReactDefaultBatchingStrategy = require("npm:react@0.13.3/lib/ReactDefaultBatchingStrategy");
    var ReactDOMComponent = require("npm:react@0.13.3/lib/ReactDOMComponent");
    var ReactDOMButton = require("npm:react@0.13.3/lib/ReactDOMButton");
    var ReactDOMForm = require("npm:react@0.13.3/lib/ReactDOMForm");
    var ReactDOMImg = require("npm:react@0.13.3/lib/ReactDOMImg");
    var ReactDOMIDOperations = require("npm:react@0.13.3/lib/ReactDOMIDOperations");
    var ReactDOMIframe = require("npm:react@0.13.3/lib/ReactDOMIframe");
    var ReactDOMInput = require("npm:react@0.13.3/lib/ReactDOMInput");
    var ReactDOMOption = require("npm:react@0.13.3/lib/ReactDOMOption");
    var ReactDOMSelect = require("npm:react@0.13.3/lib/ReactDOMSelect");
    var ReactDOMTextarea = require("npm:react@0.13.3/lib/ReactDOMTextarea");
    var ReactDOMTextComponent = require("npm:react@0.13.3/lib/ReactDOMTextComponent");
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactEventListener = require("npm:react@0.13.3/lib/ReactEventListener");
    var ReactInjection = require("npm:react@0.13.3/lib/ReactInjection");
    var ReactInstanceHandles = require("npm:react@0.13.3/lib/ReactInstanceHandles");
    var ReactMount = require("npm:react@0.13.3/lib/ReactMount");
    var ReactReconcileTransaction = require("npm:react@0.13.3/lib/ReactReconcileTransaction");
    var SelectEventPlugin = require("npm:react@0.13.3/lib/SelectEventPlugin");
    var ServerReactRootIndex = require("npm:react@0.13.3/lib/ServerReactRootIndex");
    var SimpleEventPlugin = require("npm:react@0.13.3/lib/SimpleEventPlugin");
    var SVGDOMPropertyConfig = require("npm:react@0.13.3/lib/SVGDOMPropertyConfig");
    var createFullPageComponent = require("npm:react@0.13.3/lib/createFullPageComponent");
    function autoGenerateWrapperClass(type) {
      return ReactClass.createClass({
        tagName: type.toUpperCase(),
        render: function() {
          return new ReactElement(type, null, null, null, null, this.props);
        }
      });
    }
    function inject() {
      ReactInjection.EventEmitter.injectReactEventListener(ReactEventListener);
      ReactInjection.EventPluginHub.injectEventPluginOrder(DefaultEventPluginOrder);
      ReactInjection.EventPluginHub.injectInstanceHandle(ReactInstanceHandles);
      ReactInjection.EventPluginHub.injectMount(ReactMount);
      ReactInjection.EventPluginHub.injectEventPluginsByName({
        SimpleEventPlugin: SimpleEventPlugin,
        EnterLeaveEventPlugin: EnterLeaveEventPlugin,
        ChangeEventPlugin: ChangeEventPlugin,
        MobileSafariClickEventPlugin: MobileSafariClickEventPlugin,
        SelectEventPlugin: SelectEventPlugin,
        BeforeInputEventPlugin: BeforeInputEventPlugin
      });
      ReactInjection.NativeComponent.injectGenericComponentClass(ReactDOMComponent);
      ReactInjection.NativeComponent.injectTextComponentClass(ReactDOMTextComponent);
      ReactInjection.NativeComponent.injectAutoWrapper(autoGenerateWrapperClass);
      ReactInjection.Class.injectMixin(ReactBrowserComponentMixin);
      ReactInjection.NativeComponent.injectComponentClasses({
        'button': ReactDOMButton,
        'form': ReactDOMForm,
        'iframe': ReactDOMIframe,
        'img': ReactDOMImg,
        'input': ReactDOMInput,
        'option': ReactDOMOption,
        'select': ReactDOMSelect,
        'textarea': ReactDOMTextarea,
        'html': createFullPageComponent('html'),
        'head': createFullPageComponent('head'),
        'body': createFullPageComponent('body')
      });
      ReactInjection.DOMProperty.injectDOMPropertyConfig(HTMLDOMPropertyConfig);
      ReactInjection.DOMProperty.injectDOMPropertyConfig(SVGDOMPropertyConfig);
      ReactInjection.EmptyComponent.injectEmptyComponent('noscript');
      ReactInjection.Updates.injectReconcileTransaction(ReactReconcileTransaction);
      ReactInjection.Updates.injectBatchingStrategy(ReactDefaultBatchingStrategy);
      ReactInjection.RootIndex.injectCreateReactRootIndex(ExecutionEnvironment.canUseDOM ? ClientReactRootIndex.createReactRootIndex : ServerReactRootIndex.createReactRootIndex);
      ReactInjection.Component.injectEnvironment(ReactComponentBrowserEnvironment);
      ReactInjection.DOMComponent.injectIDOperations(ReactDOMIDOperations);
      if ("production" !== process.env.NODE_ENV) {
        var url = (ExecutionEnvironment.canUseDOM && window.location.href) || '';
        if ((/[?&]react_perf\b/).test(url)) {
          var ReactDefaultPerf = require("npm:react@0.13.3/lib/ReactDefaultPerf");
          ReactDefaultPerf.start();
        }
      }
    }
    module.exports = {inject: inject};
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseIsMatch", ["npm:lodash@3.9.1/internal/baseIsEqual", "npm:lodash@3.9.1/internal/toObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseIsEqual = require("npm:lodash@3.9.1/internal/baseIsEqual"),
      toObject = require("npm:lodash@3.9.1/internal/toObject");
  function baseIsMatch(object, matchData, customizer) {
    var index = matchData.length,
        length = index,
        noCustomizer = !customizer;
    if (object == null) {
      return !length;
    }
    object = toObject(object);
    while (index--) {
      var data = matchData[index];
      if ((noCustomizer && data[2]) ? data[1] !== object[data[0]] : !(data[0] in object)) {
        return false;
      }
    }
    while (++index < length) {
      data = matchData[index];
      var key = data[0],
          objValue = object[key],
          srcValue = data[1];
      if (noCustomizer && data[2]) {
        if (objValue === undefined && !(key in object)) {
          return false;
        }
      } else {
        var result = customizer ? customizer(objValue, srcValue, key) : undefined;
        if (!(result === undefined ? baseIsEqual(srcValue, objValue, customizer, true) : result)) {
          return false;
        }
      }
    }
    return true;
  }
  module.exports = baseIsMatch;
  global.define = __define;
  return module.exports;
});



System.register("npm:color@0.8.0/index", ["npm:color-convert@0.5.2", "npm:color-string@0.3.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var convert = require("npm:color-convert@0.5.2"),
      string = require("npm:color-string@0.3.0");
  var Color = function(obj) {
    if (obj instanceof Color)
      return obj;
    if (!(this instanceof Color))
      return new Color(obj);
    this.values = {
      rgb: [0, 0, 0],
      hsl: [0, 0, 0],
      hsv: [0, 0, 0],
      hwb: [0, 0, 0],
      cmyk: [0, 0, 0, 0],
      alpha: 1
    };
    if (typeof obj == "string") {
      var vals = string.getRgba(obj);
      if (vals) {
        this.setValues("rgb", vals);
      } else if (vals = string.getHsla(obj)) {
        this.setValues("hsl", vals);
      } else if (vals = string.getHwb(obj)) {
        this.setValues("hwb", vals);
      } else {
        throw new Error("Unable to parse color from string \"" + obj + "\"");
      }
    } else if (typeof obj == "object") {
      var vals = obj;
      if (vals["r"] !== undefined || vals["red"] !== undefined) {
        this.setValues("rgb", vals);
      } else if (vals["l"] !== undefined || vals["lightness"] !== undefined) {
        this.setValues("hsl", vals);
      } else if (vals["v"] !== undefined || vals["value"] !== undefined) {
        this.setValues("hsv", vals);
      } else if (vals["w"] !== undefined || vals["whiteness"] !== undefined) {
        this.setValues("hwb", vals);
      } else if (vals["c"] !== undefined || vals["cyan"] !== undefined) {
        this.setValues("cmyk", vals);
      } else {
        throw new Error("Unable to parse color from object " + JSON.stringify(obj));
      }
    }
  };
  Color.prototype = {
    rgb: function(vals) {
      return this.setSpace("rgb", arguments);
    },
    hsl: function(vals) {
      return this.setSpace("hsl", arguments);
    },
    hsv: function(vals) {
      return this.setSpace("hsv", arguments);
    },
    hwb: function(vals) {
      return this.setSpace("hwb", arguments);
    },
    cmyk: function(vals) {
      return this.setSpace("cmyk", arguments);
    },
    rgbArray: function() {
      return this.values.rgb;
    },
    hslArray: function() {
      return this.values.hsl;
    },
    hsvArray: function() {
      return this.values.hsv;
    },
    hwbArray: function() {
      if (this.values.alpha !== 1) {
        return this.values.hwb.concat([this.values.alpha]);
      }
      return this.values.hwb;
    },
    cmykArray: function() {
      return this.values.cmyk;
    },
    rgbaArray: function() {
      var rgb = this.values.rgb;
      return rgb.concat([this.values.alpha]);
    },
    hslaArray: function() {
      var hsl = this.values.hsl;
      return hsl.concat([this.values.alpha]);
    },
    alpha: function(val) {
      if (val === undefined) {
        return this.values.alpha;
      }
      this.setValues("alpha", val);
      return this;
    },
    red: function(val) {
      return this.setChannel("rgb", 0, val);
    },
    green: function(val) {
      return this.setChannel("rgb", 1, val);
    },
    blue: function(val) {
      return this.setChannel("rgb", 2, val);
    },
    hue: function(val) {
      return this.setChannel("hsl", 0, val);
    },
    saturation: function(val) {
      return this.setChannel("hsl", 1, val);
    },
    lightness: function(val) {
      return this.setChannel("hsl", 2, val);
    },
    saturationv: function(val) {
      return this.setChannel("hsv", 1, val);
    },
    whiteness: function(val) {
      return this.setChannel("hwb", 1, val);
    },
    blackness: function(val) {
      return this.setChannel("hwb", 2, val);
    },
    value: function(val) {
      return this.setChannel("hsv", 2, val);
    },
    cyan: function(val) {
      return this.setChannel("cmyk", 0, val);
    },
    magenta: function(val) {
      return this.setChannel("cmyk", 1, val);
    },
    yellow: function(val) {
      return this.setChannel("cmyk", 2, val);
    },
    black: function(val) {
      return this.setChannel("cmyk", 3, val);
    },
    hexString: function() {
      return string.hexString(this.values.rgb);
    },
    rgbString: function() {
      return string.rgbString(this.values.rgb, this.values.alpha);
    },
    rgbaString: function() {
      return string.rgbaString(this.values.rgb, this.values.alpha);
    },
    percentString: function() {
      return string.percentString(this.values.rgb, this.values.alpha);
    },
    hslString: function() {
      return string.hslString(this.values.hsl, this.values.alpha);
    },
    hslaString: function() {
      return string.hslaString(this.values.hsl, this.values.alpha);
    },
    hwbString: function() {
      return string.hwbString(this.values.hwb, this.values.alpha);
    },
    keyword: function() {
      return string.keyword(this.values.rgb, this.values.alpha);
    },
    rgbNumber: function() {
      return (this.values.rgb[0] << 16) | (this.values.rgb[1] << 8) | this.values.rgb[2];
    },
    luminosity: function() {
      var rgb = this.values.rgb;
      var lum = [];
      for (var i = 0; i < rgb.length; i++) {
        var chan = rgb[i] / 255;
        lum[i] = (chan <= 0.03928) ? chan / 12.92 : Math.pow(((chan + 0.055) / 1.055), 2.4);
      }
      return 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
    },
    contrast: function(color2) {
      var lum1 = this.luminosity();
      var lum2 = color2.luminosity();
      if (lum1 > lum2) {
        return (lum1 + 0.05) / (lum2 + 0.05);
      }
      ;
      return (lum2 + 0.05) / (lum1 + 0.05);
    },
    level: function(color2) {
      var contrastRatio = this.contrast(color2);
      return (contrastRatio >= 7.1) ? 'AAA' : (contrastRatio >= 4.5) ? 'AA' : '';
    },
    dark: function() {
      var rgb = this.values.rgb,
          yiq = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
      return yiq < 128;
    },
    light: function() {
      return !this.dark();
    },
    negate: function() {
      var rgb = [];
      for (var i = 0; i < 3; i++) {
        rgb[i] = 255 - this.values.rgb[i];
      }
      this.setValues("rgb", rgb);
      return this;
    },
    lighten: function(ratio) {
      this.values.hsl[2] += this.values.hsl[2] * ratio;
      this.setValues("hsl", this.values.hsl);
      return this;
    },
    darken: function(ratio) {
      this.values.hsl[2] -= this.values.hsl[2] * ratio;
      this.setValues("hsl", this.values.hsl);
      return this;
    },
    saturate: function(ratio) {
      this.values.hsl[1] += this.values.hsl[1] * ratio;
      this.setValues("hsl", this.values.hsl);
      return this;
    },
    desaturate: function(ratio) {
      this.values.hsl[1] -= this.values.hsl[1] * ratio;
      this.setValues("hsl", this.values.hsl);
      return this;
    },
    whiten: function(ratio) {
      this.values.hwb[1] += this.values.hwb[1] * ratio;
      this.setValues("hwb", this.values.hwb);
      return this;
    },
    blacken: function(ratio) {
      this.values.hwb[2] += this.values.hwb[2] * ratio;
      this.setValues("hwb", this.values.hwb);
      return this;
    },
    greyscale: function() {
      var rgb = this.values.rgb;
      var val = rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11;
      this.setValues("rgb", [val, val, val]);
      return this;
    },
    clearer: function(ratio) {
      this.setValues("alpha", this.values.alpha - (this.values.alpha * ratio));
      return this;
    },
    opaquer: function(ratio) {
      this.setValues("alpha", this.values.alpha + (this.values.alpha * ratio));
      return this;
    },
    rotate: function(degrees) {
      var hue = this.values.hsl[0];
      hue = (hue + degrees) % 360;
      hue = hue < 0 ? 360 + hue : hue;
      this.values.hsl[0] = hue;
      this.setValues("hsl", this.values.hsl);
      return this;
    },
    mix: function(color2, weight) {
      weight = 1 - (weight == null ? 0.5 : weight);
      var t1 = weight * 2 - 1,
          d = this.alpha() - color2.alpha();
      var weight1 = (((t1 * d == -1) ? t1 : (t1 + d) / (1 + t1 * d)) + 1) / 2;
      var weight2 = 1 - weight1;
      var rgb = this.rgbArray();
      var rgb2 = color2.rgbArray();
      for (var i = 0; i < rgb.length; i++) {
        rgb[i] = rgb[i] * weight1 + rgb2[i] * weight2;
      }
      this.setValues("rgb", rgb);
      var alpha = this.alpha() * weight + color2.alpha() * (1 - weight);
      this.setValues("alpha", alpha);
      return this;
    },
    toJSON: function() {
      return this.rgb();
    },
    clone: function() {
      return new Color(this.rgb());
    }
  };
  Color.prototype.getValues = function(space) {
    var vals = {};
    for (var i = 0; i < space.length; i++) {
      vals[space.charAt(i)] = this.values[space][i];
    }
    if (this.values.alpha != 1) {
      vals["a"] = this.values.alpha;
    }
    return vals;
  };
  Color.prototype.setValues = function(space, vals) {
    var spaces = {
      "rgb": ["red", "green", "blue"],
      "hsl": ["hue", "saturation", "lightness"],
      "hsv": ["hue", "saturation", "value"],
      "hwb": ["hue", "whiteness", "blackness"],
      "cmyk": ["cyan", "magenta", "yellow", "black"]
    };
    var maxes = {
      "rgb": [255, 255, 255],
      "hsl": [360, 100, 100],
      "hsv": [360, 100, 100],
      "hwb": [360, 100, 100],
      "cmyk": [100, 100, 100, 100]
    };
    var alpha = 1;
    if (space == "alpha") {
      alpha = vals;
    } else if (vals.length) {
      this.values[space] = vals.slice(0, space.length);
      alpha = vals[space.length];
    } else if (vals[space.charAt(0)] !== undefined) {
      for (var i = 0; i < space.length; i++) {
        this.values[space][i] = vals[space.charAt(i)];
      }
      alpha = vals.a;
    } else if (vals[spaces[space][0]] !== undefined) {
      var chans = spaces[space];
      for (var i = 0; i < space.length; i++) {
        this.values[space][i] = vals[chans[i]];
      }
      alpha = vals.alpha;
    }
    this.values.alpha = Math.max(0, Math.min(1, (alpha !== undefined ? alpha : this.values.alpha)));
    if (space == "alpha") {
      return ;
    }
    for (var i = 0; i < space.length; i++) {
      var capped = Math.max(0, Math.min(maxes[space][i], this.values[space][i]));
      this.values[space][i] = Math.round(capped);
    }
    for (var sname in spaces) {
      if (sname != space) {
        this.values[sname] = convert[space][sname](this.values[space]);
      }
      for (var i = 0; i < sname.length; i++) {
        var capped = Math.max(0, Math.min(maxes[sname][i], this.values[sname][i]));
        this.values[sname][i] = Math.round(capped);
      }
    }
    return true;
  };
  Color.prototype.setSpace = function(space, args) {
    var vals = args[0];
    if (vals === undefined) {
      return this.getValues(space);
    }
    if (typeof vals == "number") {
      vals = Array.prototype.slice.call(args);
    }
    this.setValues(space, vals);
    return this;
  };
  Color.prototype.setChannel = function(space, index, val) {
    if (val === undefined) {
      return this.values[space][index];
    }
    this.values[space][index] = val;
    this.setValues(space, this.values[space]);
    return this;
  };
  module.exports = Color;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/string/escapeRegExp", ["npm:lodash@3.9.1/internal/baseToString"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseToString = require("npm:lodash@3.9.1/internal/baseToString");
  var reRegExpChars = /[.*+?^${}()|[\]\/\\]/g,
      reHasRegExpChars = RegExp(reRegExpChars.source);
  function escapeRegExp(string) {
    string = baseToString(string);
    return (string && reHasRegExpChars.test(string)) ? string.replace(reRegExpChars, '\\$&') : string;
  }
  module.exports = escapeRegExp;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/shimIsPlainObject", ["npm:lodash@3.9.1/internal/baseForIn", "npm:lodash@3.9.1/internal/isObjectLike"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseForIn = require("npm:lodash@3.9.1/internal/baseForIn"),
      isObjectLike = require("npm:lodash@3.9.1/internal/isObjectLike");
  var objectTag = '[object Object]';
  var objectProto = Object.prototype;
  var hasOwnProperty = objectProto.hasOwnProperty;
  var objToString = objectProto.toString;
  function shimIsPlainObject(value) {
    var Ctor;
    if (!(isObjectLike(value) && objToString.call(value) == objectTag) || (!hasOwnProperty.call(value, 'constructor') && (Ctor = value.constructor, typeof Ctor == 'function' && !(Ctor instanceof Ctor)))) {
      return false;
    }
    var result;
    baseForIn(value, function(subValue, key) {
      result = key;
    });
    return result === undefined || hasOwnProperty.call(value, result);
  }
  module.exports = shimIsPlainObject;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactChildren", ["npm:react@0.13.3/lib/PooledClass", "npm:react@0.13.3/lib/ReactFragment", "npm:react@0.13.3/lib/traverseAllChildren", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var PooledClass = require("npm:react@0.13.3/lib/PooledClass");
    var ReactFragment = require("npm:react@0.13.3/lib/ReactFragment");
    var traverseAllChildren = require("npm:react@0.13.3/lib/traverseAllChildren");
    var warning = require("npm:react@0.13.3/lib/warning");
    var twoArgumentPooler = PooledClass.twoArgumentPooler;
    var threeArgumentPooler = PooledClass.threeArgumentPooler;
    function ForEachBookKeeping(forEachFunction, forEachContext) {
      this.forEachFunction = forEachFunction;
      this.forEachContext = forEachContext;
    }
    PooledClass.addPoolingTo(ForEachBookKeeping, twoArgumentPooler);
    function forEachSingleChild(traverseContext, child, name, i) {
      var forEachBookKeeping = traverseContext;
      forEachBookKeeping.forEachFunction.call(forEachBookKeeping.forEachContext, child, i);
    }
    function forEachChildren(children, forEachFunc, forEachContext) {
      if (children == null) {
        return children;
      }
      var traverseContext = ForEachBookKeeping.getPooled(forEachFunc, forEachContext);
      traverseAllChildren(children, forEachSingleChild, traverseContext);
      ForEachBookKeeping.release(traverseContext);
    }
    function MapBookKeeping(mapResult, mapFunction, mapContext) {
      this.mapResult = mapResult;
      this.mapFunction = mapFunction;
      this.mapContext = mapContext;
    }
    PooledClass.addPoolingTo(MapBookKeeping, threeArgumentPooler);
    function mapSingleChildIntoContext(traverseContext, child, name, i) {
      var mapBookKeeping = traverseContext;
      var mapResult = mapBookKeeping.mapResult;
      var keyUnique = !mapResult.hasOwnProperty(name);
      if ("production" !== process.env.NODE_ENV) {
        ("production" !== process.env.NODE_ENV ? warning(keyUnique, 'ReactChildren.map(...): Encountered two children with the same key, ' + '`%s`. Child keys must be unique; when two children share a key, only ' + 'the first child will be used.', name) : null);
      }
      if (keyUnique) {
        var mappedChild = mapBookKeeping.mapFunction.call(mapBookKeeping.mapContext, child, i);
        mapResult[name] = mappedChild;
      }
    }
    function mapChildren(children, func, context) {
      if (children == null) {
        return children;
      }
      var mapResult = {};
      var traverseContext = MapBookKeeping.getPooled(mapResult, func, context);
      traverseAllChildren(children, mapSingleChildIntoContext, traverseContext);
      MapBookKeeping.release(traverseContext);
      return ReactFragment.create(mapResult);
    }
    function forEachSingleChildDummy(traverseContext, child, name, i) {
      return null;
    }
    function countChildren(children, context) {
      return traverseAllChildren(children, forEachSingleChildDummy, null);
    }
    var ReactChildren = {
      forEach: forEachChildren,
      map: mapChildren,
      count: countChildren
    };
    module.exports = ReactChildren;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactComponent", ["npm:react@0.13.3/lib/ReactUpdateQueue", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/warning", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactUpdateQueue = require("npm:react@0.13.3/lib/ReactUpdateQueue");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var warning = require("npm:react@0.13.3/lib/warning");
    function ReactComponent(props, context) {
      this.props = props;
      this.context = context;
    }
    ReactComponent.prototype.setState = function(partialState, callback) {
      ("production" !== process.env.NODE_ENV ? invariant(typeof partialState === 'object' || typeof partialState === 'function' || partialState == null, 'setState(...): takes an object of state variables to update or a ' + 'function which returns an object of state variables.') : invariant(typeof partialState === 'object' || typeof partialState === 'function' || partialState == null));
      if ("production" !== process.env.NODE_ENV) {
        ("production" !== process.env.NODE_ENV ? warning(partialState != null, 'setState(...): You passed an undefined or null state object; ' + 'instead, use forceUpdate().') : null);
      }
      ReactUpdateQueue.enqueueSetState(this, partialState);
      if (callback) {
        ReactUpdateQueue.enqueueCallback(this, callback);
      }
    };
    ReactComponent.prototype.forceUpdate = function(callback) {
      ReactUpdateQueue.enqueueForceUpdate(this);
      if (callback) {
        ReactUpdateQueue.enqueueCallback(this, callback);
      }
    };
    if ("production" !== process.env.NODE_ENV) {
      var deprecatedAPIs = {
        getDOMNode: ['getDOMNode', 'Use React.findDOMNode(component) instead.'],
        isMounted: ['isMounted', 'Instead, make sure to clean up subscriptions and pending requests in ' + 'componentWillUnmount to prevent memory leaks.'],
        replaceProps: ['replaceProps', 'Instead, call React.render again at the top level.'],
        replaceState: ['replaceState', 'Refactor your code to use setState instead (see ' + 'https://github.com/facebook/react/issues/3236).'],
        setProps: ['setProps', 'Instead, call React.render again at the top level.']
      };
      var defineDeprecationWarning = function(methodName, info) {
        try {
          Object.defineProperty(ReactComponent.prototype, methodName, {get: function() {
              ("production" !== process.env.NODE_ENV ? warning(false, '%s(...) is deprecated in plain JavaScript React classes. %s', info[0], info[1]) : null);
              return undefined;
            }});
        } catch (x) {}
      };
      for (var fnName in deprecatedAPIs) {
        if (deprecatedAPIs.hasOwnProperty(fnName)) {
          defineDeprecationWarning(fnName, deprecatedAPIs[fnName]);
        }
      }
    }
    module.exports = ReactComponent;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOMIDOperations", ["npm:react@0.13.3/lib/CSSPropertyOperations", "npm:react@0.13.3/lib/DOMChildrenOperations", "npm:react@0.13.3/lib/DOMPropertyOperations", "npm:react@0.13.3/lib/ReactMount", "npm:react@0.13.3/lib/ReactPerf", "npm:react@0.13.3/lib/invariant", "npm:react@0.13.3/lib/setInnerHTML", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var CSSPropertyOperations = require("npm:react@0.13.3/lib/CSSPropertyOperations");
    var DOMChildrenOperations = require("npm:react@0.13.3/lib/DOMChildrenOperations");
    var DOMPropertyOperations = require("npm:react@0.13.3/lib/DOMPropertyOperations");
    var ReactMount = require("npm:react@0.13.3/lib/ReactMount");
    var ReactPerf = require("npm:react@0.13.3/lib/ReactPerf");
    var invariant = require("npm:react@0.13.3/lib/invariant");
    var setInnerHTML = require("npm:react@0.13.3/lib/setInnerHTML");
    var INVALID_PROPERTY_ERRORS = {
      dangerouslySetInnerHTML: '`dangerouslySetInnerHTML` must be set using `updateInnerHTMLByID()`.',
      style: '`style` must be set using `updateStylesByID()`.'
    };
    var ReactDOMIDOperations = {
      updatePropertyByID: function(id, name, value) {
        var node = ReactMount.getNode(id);
        ("production" !== process.env.NODE_ENV ? invariant(!INVALID_PROPERTY_ERRORS.hasOwnProperty(name), 'updatePropertyByID(...): %s', INVALID_PROPERTY_ERRORS[name]) : invariant(!INVALID_PROPERTY_ERRORS.hasOwnProperty(name)));
        if (value != null) {
          DOMPropertyOperations.setValueForProperty(node, name, value);
        } else {
          DOMPropertyOperations.deleteValueForProperty(node, name);
        }
      },
      deletePropertyByID: function(id, name, value) {
        var node = ReactMount.getNode(id);
        ("production" !== process.env.NODE_ENV ? invariant(!INVALID_PROPERTY_ERRORS.hasOwnProperty(name), 'updatePropertyByID(...): %s', INVALID_PROPERTY_ERRORS[name]) : invariant(!INVALID_PROPERTY_ERRORS.hasOwnProperty(name)));
        DOMPropertyOperations.deleteValueForProperty(node, name, value);
      },
      updateStylesByID: function(id, styles) {
        var node = ReactMount.getNode(id);
        CSSPropertyOperations.setValueForStyles(node, styles);
      },
      updateInnerHTMLByID: function(id, html) {
        var node = ReactMount.getNode(id);
        setInnerHTML(node, html);
      },
      updateTextContentByID: function(id, content) {
        var node = ReactMount.getNode(id);
        DOMChildrenOperations.updateTextContent(node, content);
      },
      dangerouslyReplaceNodeWithMarkupByID: function(id, markup) {
        var node = ReactMount.getNode(id);
        DOMChildrenOperations.dangerouslyReplaceNodeWithMarkup(node, markup);
      },
      dangerouslyProcessChildrenUpdates: function(updates, markup) {
        for (var i = 0; i < updates.length; i++) {
          updates[i].parentNode = ReactMount.getNode(updates[i].parentID);
        }
        DOMChildrenOperations.processUpdates(updates, markup);
      }
    };
    ReactPerf.measureMethods(ReactDOMIDOperations, 'ReactDOMIDOperations', {
      updatePropertyByID: 'updatePropertyByID',
      deletePropertyByID: 'deletePropertyByID',
      updateStylesByID: 'updateStylesByID',
      updateInnerHTMLByID: 'updateInnerHTMLByID',
      updateTextContentByID: 'updateTextContentByID',
      dangerouslyReplaceNodeWithMarkupByID: 'dangerouslyReplaceNodeWithMarkupByID',
      dangerouslyProcessChildrenUpdates: 'dangerouslyProcessChildrenUpdates'
    });
    module.exports = ReactDOMIDOperations;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseMatches", ["npm:lodash@3.9.1/internal/baseIsMatch", "npm:lodash@3.9.1/internal/getMatchData", "npm:lodash@3.9.1/internal/toObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseIsMatch = require("npm:lodash@3.9.1/internal/baseIsMatch"),
      getMatchData = require("npm:lodash@3.9.1/internal/getMatchData"),
      toObject = require("npm:lodash@3.9.1/internal/toObject");
  function baseMatches(source) {
    var matchData = getMatchData(source);
    if (matchData.length == 1 && matchData[0][2]) {
      var key = matchData[0][0],
          value = matchData[0][1];
      return function(object) {
        if (object == null) {
          return false;
        }
        return object[key] === value && (value !== undefined || (key in toObject(object)));
      };
    }
    return function(object) {
      return baseIsMatch(object, matchData);
    };
  }
  module.exports = baseMatches;
  global.define = __define;
  return module.exports;
});



System.register("npm:color@0.8.0", ["npm:color@0.8.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:color@0.8.0/index");
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/lang/isNative", ["npm:lodash@3.9.1/string/escapeRegExp", "npm:lodash@3.9.1/internal/isObjectLike"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var escapeRegExp = require("npm:lodash@3.9.1/string/escapeRegExp"),
      isObjectLike = require("npm:lodash@3.9.1/internal/isObjectLike");
  var funcTag = '[object Function]';
  var reIsHostCtor = /^\[object .+?Constructor\]$/;
  var objectProto = Object.prototype;
  var fnToString = Function.prototype.toString;
  var hasOwnProperty = objectProto.hasOwnProperty;
  var objToString = objectProto.toString;
  var reIsNative = RegExp('^' + escapeRegExp(fnToString.call(hasOwnProperty)).replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, '$1.*?') + '$');
  function isNative(value) {
    if (value == null) {
      return false;
    }
    if (objToString.call(value) == funcTag) {
      return reIsNative.test(fnToString.call(value));
    }
    return isObjectLike(value) && reIsHostCtor.test(value);
  }
  module.exports = isNative;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/lang/isPlainObject", ["npm:lodash@3.9.1/internal/getNative", "npm:lodash@3.9.1/internal/shimIsPlainObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var getNative = require("npm:lodash@3.9.1/internal/getNative"),
      shimIsPlainObject = require("npm:lodash@3.9.1/internal/shimIsPlainObject");
  var objectTag = '[object Object]';
  var objectProto = Object.prototype;
  var objToString = objectProto.toString;
  var getPrototypeOf = getNative(Object, 'getPrototypeOf');
  var isPlainObject = !getPrototypeOf ? shimIsPlainObject : function(value) {
    if (!(value && objToString.call(value) == objectTag)) {
      return false;
    }
    var valueOf = getNative(value, 'valueOf'),
        objProto = valueOf && (objProto = getPrototypeOf(valueOf)) && getPrototypeOf(objProto);
    return objProto ? (value == objProto || getPrototypeOf(value) == objProto) : shimIsPlainObject(value);
  };
  module.exports = isPlainObject;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactComponentBrowserEnvironment", ["npm:react@0.13.3/lib/ReactDOMIDOperations", "npm:react@0.13.3/lib/ReactMount", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ReactDOMIDOperations = require("npm:react@0.13.3/lib/ReactDOMIDOperations");
    var ReactMount = require("npm:react@0.13.3/lib/ReactMount");
    var ReactComponentBrowserEnvironment = {
      processChildrenUpdates: ReactDOMIDOperations.dangerouslyProcessChildrenUpdates,
      replaceNodeWithMarkupByID: ReactDOMIDOperations.dangerouslyReplaceNodeWithMarkupByID,
      unmountIDFromEnvironment: function(rootNodeID) {
        ReactMount.purgeID(rootNodeID);
      }
    };
    module.exports = ReactComponentBrowserEnvironment;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseCallback", ["npm:lodash@3.9.1/internal/baseMatches", "npm:lodash@3.9.1/internal/baseMatchesProperty", "npm:lodash@3.9.1/internal/bindCallback", "npm:lodash@3.9.1/utility/identity", "npm:lodash@3.9.1/utility/property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseMatches = require("npm:lodash@3.9.1/internal/baseMatches"),
      baseMatchesProperty = require("npm:lodash@3.9.1/internal/baseMatchesProperty"),
      bindCallback = require("npm:lodash@3.9.1/internal/bindCallback"),
      identity = require("npm:lodash@3.9.1/utility/identity"),
      property = require("npm:lodash@3.9.1/utility/property");
  function baseCallback(func, thisArg, argCount) {
    var type = typeof func;
    if (type == 'function') {
      return thisArg === undefined ? func : bindCallback(func, thisArg, argCount);
    }
    if (func == null) {
      return identity;
    }
    if (type == 'object') {
      return baseMatches(func);
    }
    return thisArg === undefined ? property(func) : baseMatchesProperty(func, thisArg);
  }
  module.exports = baseCallback;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/getNative", ["npm:lodash@3.9.1/lang/isNative"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isNative = require("npm:lodash@3.9.1/lang/isNative");
  function getNative(object, key) {
    var value = object == null ? undefined : object[key];
    return isNative(value) ? value : undefined;
  }
  module.exports = getNative;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/ReactDOMTextComponent", ["npm:react@0.13.3/lib/DOMPropertyOperations", "npm:react@0.13.3/lib/ReactComponentBrowserEnvironment", "npm:react@0.13.3/lib/ReactDOMComponent", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/escapeTextContentForBrowser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var DOMPropertyOperations = require("npm:react@0.13.3/lib/DOMPropertyOperations");
  var ReactComponentBrowserEnvironment = require("npm:react@0.13.3/lib/ReactComponentBrowserEnvironment");
  var ReactDOMComponent = require("npm:react@0.13.3/lib/ReactDOMComponent");
  var assign = require("npm:react@0.13.3/lib/Object.assign");
  var escapeTextContentForBrowser = require("npm:react@0.13.3/lib/escapeTextContentForBrowser");
  var ReactDOMTextComponent = function(props) {};
  assign(ReactDOMTextComponent.prototype, {
    construct: function(text) {
      this._currentElement = text;
      this._stringText = '' + text;
      this._rootNodeID = null;
      this._mountIndex = 0;
    },
    mountComponent: function(rootID, transaction, context) {
      this._rootNodeID = rootID;
      var escapedText = escapeTextContentForBrowser(this._stringText);
      if (transaction.renderToStaticMarkup) {
        return escapedText;
      }
      return ('<span ' + DOMPropertyOperations.createMarkupForID(rootID) + '>' + escapedText + '</span>');
    },
    receiveComponent: function(nextText, transaction) {
      if (nextText !== this._currentElement) {
        this._currentElement = nextText;
        var nextStringText = '' + nextText;
        if (nextStringText !== this._stringText) {
          this._stringText = nextStringText;
          ReactDOMComponent.BackendIDOperations.updateTextContentByID(this._rootNodeID, nextStringText);
        }
      }
    },
    unmountComponent: function() {
      ReactComponentBrowserEnvironment.unmountIDFromEnvironment(this._rootNodeID);
    }
  });
  module.exports = ReactDOMTextComponent;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/createReduce", ["npm:lodash@3.9.1/internal/baseCallback", "npm:lodash@3.9.1/internal/baseReduce", "npm:lodash@3.9.1/lang/isArray"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseCallback = require("npm:lodash@3.9.1/internal/baseCallback"),
      baseReduce = require("npm:lodash@3.9.1/internal/baseReduce"),
      isArray = require("npm:lodash@3.9.1/lang/isArray");
  function createReduce(arrayFunc, eachFunc) {
    return function(collection, iteratee, accumulator, thisArg) {
      var initFromArray = arguments.length < 3;
      return (typeof iteratee == 'function' && thisArg === undefined && isArray(collection)) ? arrayFunc(collection, iteratee, accumulator, initFromArray) : baseReduce(collection, baseCallback(iteratee, thisArg, 4), accumulator, initFromArray, eachFunc);
    };
  }
  module.exports = createReduce;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/lang/isArray", ["npm:lodash@3.9.1/internal/getNative", "npm:lodash@3.9.1/internal/isLength", "npm:lodash@3.9.1/internal/isObjectLike"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var getNative = require("npm:lodash@3.9.1/internal/getNative"),
      isLength = require("npm:lodash@3.9.1/internal/isLength"),
      isObjectLike = require("npm:lodash@3.9.1/internal/isObjectLike");
  var arrayTag = '[object Array]';
  var objectProto = Object.prototype;
  var objToString = objectProto.toString;
  var nativeIsArray = getNative(Array, 'isArray');
  var isArray = nativeIsArray || function(value) {
    return isObjectLike(value) && isLength(value.length) && objToString.call(value) == arrayTag;
  };
  module.exports = isArray;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/lib/React", ["npm:react@0.13.3/lib/EventPluginUtils", "npm:react@0.13.3/lib/ReactChildren", "npm:react@0.13.3/lib/ReactComponent", "npm:react@0.13.3/lib/ReactClass", "npm:react@0.13.3/lib/ReactContext", "npm:react@0.13.3/lib/ReactCurrentOwner", "npm:react@0.13.3/lib/ReactElement", "npm:react@0.13.3/lib/ReactElementValidator", "npm:react@0.13.3/lib/ReactDOM", "npm:react@0.13.3/lib/ReactDOMTextComponent", "npm:react@0.13.3/lib/ReactDefaultInjection", "npm:react@0.13.3/lib/ReactInstanceHandles", "npm:react@0.13.3/lib/ReactMount", "npm:react@0.13.3/lib/ReactPerf", "npm:react@0.13.3/lib/ReactPropTypes", "npm:react@0.13.3/lib/ReactReconciler", "npm:react@0.13.3/lib/ReactServerRendering", "npm:react@0.13.3/lib/Object.assign", "npm:react@0.13.3/lib/findDOMNode", "npm:react@0.13.3/lib/onlyChild", "npm:react@0.13.3/lib/ExecutionEnvironment", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var EventPluginUtils = require("npm:react@0.13.3/lib/EventPluginUtils");
    var ReactChildren = require("npm:react@0.13.3/lib/ReactChildren");
    var ReactComponent = require("npm:react@0.13.3/lib/ReactComponent");
    var ReactClass = require("npm:react@0.13.3/lib/ReactClass");
    var ReactContext = require("npm:react@0.13.3/lib/ReactContext");
    var ReactCurrentOwner = require("npm:react@0.13.3/lib/ReactCurrentOwner");
    var ReactElement = require("npm:react@0.13.3/lib/ReactElement");
    var ReactElementValidator = require("npm:react@0.13.3/lib/ReactElementValidator");
    var ReactDOM = require("npm:react@0.13.3/lib/ReactDOM");
    var ReactDOMTextComponent = require("npm:react@0.13.3/lib/ReactDOMTextComponent");
    var ReactDefaultInjection = require("npm:react@0.13.3/lib/ReactDefaultInjection");
    var ReactInstanceHandles = require("npm:react@0.13.3/lib/ReactInstanceHandles");
    var ReactMount = require("npm:react@0.13.3/lib/ReactMount");
    var ReactPerf = require("npm:react@0.13.3/lib/ReactPerf");
    var ReactPropTypes = require("npm:react@0.13.3/lib/ReactPropTypes");
    var ReactReconciler = require("npm:react@0.13.3/lib/ReactReconciler");
    var ReactServerRendering = require("npm:react@0.13.3/lib/ReactServerRendering");
    var assign = require("npm:react@0.13.3/lib/Object.assign");
    var findDOMNode = require("npm:react@0.13.3/lib/findDOMNode");
    var onlyChild = require("npm:react@0.13.3/lib/onlyChild");
    ReactDefaultInjection.inject();
    var createElement = ReactElement.createElement;
    var createFactory = ReactElement.createFactory;
    var cloneElement = ReactElement.cloneElement;
    if ("production" !== process.env.NODE_ENV) {
      createElement = ReactElementValidator.createElement;
      createFactory = ReactElementValidator.createFactory;
      cloneElement = ReactElementValidator.cloneElement;
    }
    var render = ReactPerf.measure('React', 'render', ReactMount.render);
    var React = {
      Children: {
        map: ReactChildren.map,
        forEach: ReactChildren.forEach,
        count: ReactChildren.count,
        only: onlyChild
      },
      Component: ReactComponent,
      DOM: ReactDOM,
      PropTypes: ReactPropTypes,
      initializeTouchEvents: function(shouldUseTouch) {
        EventPluginUtils.useTouchEvents = shouldUseTouch;
      },
      createClass: ReactClass.createClass,
      createElement: createElement,
      cloneElement: cloneElement,
      createFactory: createFactory,
      createMixin: function(mixin) {
        return mixin;
      },
      constructAndRenderComponent: ReactMount.constructAndRenderComponent,
      constructAndRenderComponentByID: ReactMount.constructAndRenderComponentByID,
      findDOMNode: findDOMNode,
      render: render,
      renderToString: ReactServerRendering.renderToString,
      renderToStaticMarkup: ReactServerRendering.renderToStaticMarkup,
      unmountComponentAtNode: ReactMount.unmountComponentAtNode,
      isValidElement: ReactElement.isValidElement,
      withContext: ReactContext.withContext,
      __spread: assign
    };
    if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined' && typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.inject === 'function') {
      __REACT_DEVTOOLS_GLOBAL_HOOK__.inject({
        CurrentOwner: ReactCurrentOwner,
        InstanceHandles: ReactInstanceHandles,
        Mount: ReactMount,
        Reconciler: ReactReconciler,
        TextComponent: ReactDOMTextComponent
      });
    }
    if ("production" !== process.env.NODE_ENV) {
      var ExecutionEnvironment = require("npm:react@0.13.3/lib/ExecutionEnvironment");
      if (ExecutionEnvironment.canUseDOM && window.top === window.self) {
        if (navigator.userAgent.indexOf('Chrome') > -1) {
          if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ === 'undefined') {
            console.debug('Download the React DevTools for a better development experience: ' + 'https://fb.me/react-devtools');
          }
        }
        var expectedFeatures = [Array.isArray, Array.prototype.every, Array.prototype.forEach, Array.prototype.indexOf, Array.prototype.map, Date.now, Function.prototype.bind, Object.keys, String.prototype.split, String.prototype.trim, Object.create, Object.freeze];
        for (var i = 0; i < expectedFeatures.length; i++) {
          if (!expectedFeatures[i]) {
            console.error('One or more ES5 shim/shams expected by React are not available: ' + 'https://fb.me/react-warning-polyfills');
            break;
          }
        }
      }
    }
    React.version = '0.13.3';
    module.exports = React;
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/collection/reduce", ["npm:lodash@3.9.1/internal/arrayReduce", "npm:lodash@3.9.1/internal/baseEach", "npm:lodash@3.9.1/internal/createReduce"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var arrayReduce = require("npm:lodash@3.9.1/internal/arrayReduce"),
      baseEach = require("npm:lodash@3.9.1/internal/baseEach"),
      createReduce = require("npm:lodash@3.9.1/internal/createReduce");
  var reduce = createReduce(arrayReduce, baseEach);
  module.exports = reduce;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseMergeDeep", ["npm:lodash@3.9.1/internal/arrayCopy", "npm:lodash@3.9.1/lang/isArguments", "npm:lodash@3.9.1/lang/isArray", "npm:lodash@3.9.1/internal/isArrayLike", "npm:lodash@3.9.1/lang/isPlainObject", "npm:lodash@3.9.1/lang/isTypedArray", "npm:lodash@3.9.1/lang/toPlainObject"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var arrayCopy = require("npm:lodash@3.9.1/internal/arrayCopy"),
      isArguments = require("npm:lodash@3.9.1/lang/isArguments"),
      isArray = require("npm:lodash@3.9.1/lang/isArray"),
      isArrayLike = require("npm:lodash@3.9.1/internal/isArrayLike"),
      isPlainObject = require("npm:lodash@3.9.1/lang/isPlainObject"),
      isTypedArray = require("npm:lodash@3.9.1/lang/isTypedArray"),
      toPlainObject = require("npm:lodash@3.9.1/lang/toPlainObject");
  function baseMergeDeep(object, source, key, mergeFunc, customizer, stackA, stackB) {
    var length = stackA.length,
        srcValue = source[key];
    while (length--) {
      if (stackA[length] == srcValue) {
        object[key] = stackB[length];
        return ;
      }
    }
    var value = object[key],
        result = customizer ? customizer(value, srcValue, key, object, source) : undefined,
        isCommon = result === undefined;
    if (isCommon) {
      result = srcValue;
      if (isArrayLike(srcValue) && (isArray(srcValue) || isTypedArray(srcValue))) {
        result = isArray(value) ? value : (isArrayLike(value) ? arrayCopy(value) : []);
      } else if (isPlainObject(srcValue) || isArguments(srcValue)) {
        result = isArguments(value) ? toPlainObject(value) : (isPlainObject(value) ? value : {});
      } else {
        isCommon = false;
      }
    }
    stackA.push(srcValue);
    stackB.push(result);
    if (isCommon) {
      object[key] = mergeFunc(result, srcValue, customizer, stackA, stackB);
    } else if (result === result ? (result !== value) : (value === value)) {
      object[key] = result;
    }
  }
  module.exports = baseMergeDeep;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3/react", ["npm:react@0.13.3/lib/React"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:react@0.13.3/lib/React");
  global.define = __define;
  return module.exports;
});



System.register("npm:radium@0.10.3/modules/components/style", ["npm:react@0.13.3", "npm:react@0.13.3/lib/CSSPropertyOperations", "npm:lodash@3.9.1/collection/reduce", "npm:radium@0.10.3/modules/mixins/match-media-item"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var React = require("npm:react@0.13.3");
  var CSSPropertyOperations = require("npm:react@0.13.3/lib/CSSPropertyOperations");
  var reduce = require("npm:lodash@3.9.1/collection/reduce");
  var MatchMediaItem = require("npm:radium@0.10.3/modules/mixins/match-media-item");
  function buildCssString(selector, rules) {
    if (!selector || !rules) {
      return ;
    }
    return selector + '{' + CSSPropertyOperations.createMarkupForStyles(rules) + '}';
  }
  var Style = React.createClass({
    mixins: [MatchMediaItem],
    propTypes: {
      scopeSelector: React.PropTypes.string,
      rules: React.PropTypes.arrayOf(React.PropTypes.object)
    },
    getDefaultProps: function() {
      return {scopeSelector: ''};
    },
    _buildStyles: function(stylesArr) {
      var styles = reduce(stylesArr, function(accumulator, item) {
        var selector = Object.keys(item)[0];
        var rules = item[selector];
        if (selector === 'mediaQueries') {
          accumulator += this._buildMediaQueryString(rules);
        } else {
          var completeSelector = (this.props.scopeSelector ? this.props.scopeSelector + ' ' : '') + selector;
          accumulator += buildCssString(completeSelector, rules);
        }
        return accumulator;
      }, '', this);
      return styles;
    },
    _buildMediaQueryString: function(mediaQueryObj) {
      var contextMediaQueries = this._getContextMediaQueries();
      var mediaQueryString = '';
      Object.keys(mediaQueryObj).forEach(function(query) {
        var completeQuery = contextMediaQueries[query] ? contextMediaQueries[query] : query;
        mediaQueryString += '@media ' + completeQuery + '{' + this._buildStyles(mediaQueryObj[query]) + '}';
      }.bind(this));
      return mediaQueryString;
    },
    _getContextMediaQueries: function() {
      var contextMediaQueries = {};
      if (this.context && this.context.mediaQueries) {
        Object.keys(this.context.mediaQueries).forEach(function(query) {
          contextMediaQueries[query] = this.context.mediaQueries[query].media;
        }.bind(this));
      }
      return contextMediaQueries;
    },
    render: function() {
      if (!this.props.rules) {
        return null;
      }
      var styles = this._buildStyles(this.props.rules);
      return React.createElement('style', {dangerouslySetInnerHTML: {__html: styles}});
    }
  });
  module.exports = Style;
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/internal/baseMerge", ["npm:lodash@3.9.1/internal/arrayEach", "npm:lodash@3.9.1/internal/baseMergeDeep", "npm:lodash@3.9.1/lang/isArray", "npm:lodash@3.9.1/internal/isArrayLike", "npm:lodash@3.9.1/lang/isObject", "npm:lodash@3.9.1/internal/isObjectLike", "npm:lodash@3.9.1/lang/isTypedArray", "npm:lodash@3.9.1/object/keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var arrayEach = require("npm:lodash@3.9.1/internal/arrayEach"),
      baseMergeDeep = require("npm:lodash@3.9.1/internal/baseMergeDeep"),
      isArray = require("npm:lodash@3.9.1/lang/isArray"),
      isArrayLike = require("npm:lodash@3.9.1/internal/isArrayLike"),
      isObject = require("npm:lodash@3.9.1/lang/isObject"),
      isObjectLike = require("npm:lodash@3.9.1/internal/isObjectLike"),
      isTypedArray = require("npm:lodash@3.9.1/lang/isTypedArray"),
      keys = require("npm:lodash@3.9.1/object/keys");
  function baseMerge(object, source, customizer, stackA, stackB) {
    if (!isObject(object)) {
      return object;
    }
    var isSrcArr = isArrayLike(source) && (isArray(source) || isTypedArray(source)),
        props = isSrcArr ? null : keys(source);
    arrayEach(props || source, function(srcValue, key) {
      if (props) {
        key = srcValue;
        srcValue = source[key];
      }
      if (isObjectLike(srcValue)) {
        stackA || (stackA = []);
        stackB || (stackB = []);
        baseMergeDeep(object, source, key, baseMerge, customizer, stackA, stackB);
      } else {
        var value = object[key],
            result = customizer ? customizer(value, srcValue, key, object, source) : undefined,
            isCommon = result === undefined;
        if (isCommon) {
          result = srcValue;
        }
        if ((result !== undefined || (isSrcArr && !(key in object))) && (isCommon || (result === result ? (result !== value) : (value === value)))) {
          object[key] = result;
        }
      }
    });
    return object;
  }
  module.exports = baseMerge;
  global.define = __define;
  return module.exports;
});



System.register("npm:react@0.13.3", ["npm:react@0.13.3/react"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:react@0.13.3/react");
  global.define = __define;
  return module.exports;
});



System.register("npm:lodash@3.9.1/object/merge", ["npm:lodash@3.9.1/internal/baseMerge", "npm:lodash@3.9.1/internal/createAssigner"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var baseMerge = require("npm:lodash@3.9.1/internal/baseMerge"),
      createAssigner = require("npm:lodash@3.9.1/internal/createAssigner");
  var merge = createAssigner(baseMerge);
  module.exports = merge;
  global.define = __define;
  return module.exports;
});



System.register("npm:radium@0.10.3/modules/mixins/match-media-base", ["npm:react@0.13.3", "npm:lodash@3.9.1/function/debounce"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var React = require("npm:react@0.13.3");
  var debounce = require("npm:lodash@3.9.1/function/debounce");
  var matchers = {};
  var matchedQueries;
  var mediaChangeCallback;
  var onMediaChange = function() {
    mediaChangeCallback();
  };
  var MatchMediaBase = {
    childContextTypes: {mediaQueries: React.PropTypes.object},
    getChildContext: function() {
      return {mediaQueries: this.getMatchedMedia()};
    },
    init: function(mediaQueryOpts) {
      if (!mediaQueryOpts) {
        return ;
      }
      Object.keys(mediaQueryOpts).forEach(function(key) {
        matchers[key] = (typeof window === 'undefined') ? {
          matches: false,
          media: mediaQueryOpts[key]
        } : window.matchMedia(mediaQueryOpts[key]);
        if (matchers[key].addListener) {
          matchers[key].addListener(onMediaChange);
        }
      });
    },
    componentWillMount: function() {
      mediaChangeCallback = this.handleMediaChange;
    },
    componentWillUnmount: function() {
      mediaChangeCallback = null;
      Object.keys(matchers).forEach(function(key) {
        if (matchers[key].removeListener) {
          matchers[key].removeListener(onMediaChange);
        }
      });
    },
    getMatchedMedia: function() {
      return matchedQueries || this._updateMatchedMedia();
    },
    handleMediaChange: debounce(function() {
      this._updateMatchedMedia();
      this.forceUpdate();
    }, 10, {maxWait: 250}),
    _updateMatchedMedia: function() {
      Object.keys(matchers).forEach(function(key) {
        if (!matchedQueries) {
          matchedQueries = {};
        }
        matchedQueries[key] = {
          matches: matchers[key].matches,
          media: matchers[key].media
        };
      });
      return matchedQueries;
    }
  };
  module.exports = MatchMediaBase;
  global.define = __define;
  return module.exports;
});



System.register("npm:radium@0.10.3/modules/mixins/style-resolver", ["npm:lodash@3.9.1/object/merge"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var merge = require("npm:lodash@3.9.1/object/merge");
  var StyleResolverMixin = {
    _getStateStyles: function(states, component) {
      if (!Array.isArray(states)) {
        return ;
      }
      var stateStyles = {};
      states.forEach(function(stateObj) {
        var key = Object.keys(stateObj)[0];
        var state = stateObj[key];
        if (component.state[key]) {
          merge(stateStyles, state);
        }
      });
      return stateStyles;
    },
    _getMediaQueryStyles: function(styles) {
      if (!Array.isArray(styles.mediaQueries) || !this.context || !this.context.mediaQueries) {
        return styles;
      }
      var mediaQueryStyles = merge({}, styles);
      var componentMediaQueries = this.context.mediaQueries;
      styles.mediaQueries.forEach(function(mediaQueryObj) {
        var key = Object.keys(mediaQueryObj)[0];
        var mediaQuery = mediaQueryObj[key];
        if (componentMediaQueries && componentMediaQueries[key] && componentMediaQueries[key].matches) {
          var activeMediaQuery = mediaQuery;
          if (!activeMediaQuery) {
            return ;
          }
          merge(mediaQueryStyles, activeMediaQuery);
        }
      });
      return mediaQueryStyles;
    },
    _getModifierStyles: function(styles, activeModifiers) {
      if (!activeModifiers || !Array.isArray(styles.modifiers)) {
        return styles;
      }
      var modifierStyles = merge({}, styles);
      styles.modifiers.forEach(function(modifierObj) {
        var key = Object.keys(modifierObj)[0];
        var modifier = modifierObj[key];
        if (activeModifiers[key]) {
          var modifierValue = activeModifiers[key];
          var activeModifier;
          if (typeof modifierValue === 'string') {
            activeModifier = modifier[modifierValue];
          } else if (modifierValue === true || modifierValue === false) {
            activeModifier = modifier;
          } else {
            return ;
          }
          if (!activeModifier) {
            return ;
          }
          merge(modifierStyles, activeModifier);
        }
      });
      return modifierStyles;
    },
    _getStaticStyles: function(styles, activeModifiers) {
      var elementStyles = this._getModifierStyles(styles, activeModifiers);
      var mediaQueryStyles = this._getMediaQueryStyles(elementStyles);
      return merge({}, mediaQueryStyles, this.props.style, this._getStateStyles(mediaQueryStyles.states, this), {states: null});
    },
    _getComputedStyles: function(styles) {
      if (!styles.computed) {
        return styles;
      }
      var computedStyles = {};
      if (typeof styles.computed === 'function') {
        computedStyles = styles.computed(styles);
      } else {
        Object.keys(styles.computed).forEach(function(key) {
          computedStyles[key] = styles.computed[key](styles);
        });
      }
      return merge({}, styles, computedStyles, {computed: null});
    },
    buildStyles: function(styles, additionalModifiers, excludeProps) {
      var modifiers;
      if (excludeProps) {
        modifiers = additionalModifiers;
      } else {
        modifiers = merge({}, this.props, additionalModifiers);
      }
      var staticStyles = this._getStaticStyles(styles, modifiers);
      staticStyles.modifiers = null;
      staticStyles.mediaQueries = null;
      staticStyles.states = null;
      return this._getComputedStyles(staticStyles);
    }
  };
  module.exports = StyleResolverMixin;
  global.define = __define;
  return module.exports;
});



System.register("npm:radium@0.10.3/modules/index", ["npm:radium@0.10.3/modules/mixins/style-resolver", "npm:radium@0.10.3/modules/mixins/browser-state", "npm:radium@0.10.3/modules/mixins/match-media-base", "npm:radium@0.10.3/modules/mixins/match-media-item", "npm:radium@0.10.3/modules/components/style"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  exports.StyleResolverMixin = require("npm:radium@0.10.3/modules/mixins/style-resolver");
  exports.BrowserStateMixin = require("npm:radium@0.10.3/modules/mixins/browser-state");
  exports.MatchMediaBase = require("npm:radium@0.10.3/modules/mixins/match-media-base");
  exports.MatchMediaItem = require("npm:radium@0.10.3/modules/mixins/match-media-item");
  exports.Style = require("npm:radium@0.10.3/modules/components/style");
  global.define = __define;
  return module.exports;
});



System.register("npm:radium@0.10.3", ["npm:radium@0.10.3/modules/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:radium@0.10.3/modules/index");
  global.define = __define;
  return module.exports;
});



System.register("~/app", ["npm:radium@0.10.3", "npm:color@0.8.0", "npm:immutable@3.7.2", "npm:flux@2.0.3", "~/bootstrap.jsx!github:floatdrop/plugin-jsx@1.1.0"], function (_export) {
  var Radium, color, immutable, flux, bootstrap;
  return {
    setters: [function (_npmRadium0103) {
      Radium = _npmRadium0103["default"];
    }, function (_npmColor080) {
      color = _npmColor080["default"];
    }, function (_npmImmutable372) {
      immutable = _npmImmutable372["default"];
    }, function (_npmFlux203) {
      flux = _npmFlux203["default"];
    }, function (_bootstrapJsxGithubFloatdropPluginJsx110) {
      bootstrap = _bootstrapJsxGithubFloatdropPluginJsx110["default"];
    }],
    execute: function () {
      "use strict";

      bootstrap();
    }
  };
});
});
//# sourceMappingURL=app.js.map