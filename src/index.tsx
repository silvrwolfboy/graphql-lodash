import {
  Source,
  Kind,
  parse,
  GraphQLError,
  visit,
  getOperationAST,
  print,
  concatAST,
  buildASTSchema,
} from 'graphql';

import {
  getArgumentValues,
} from 'graphql/execution/values';

import * as _ from 'lodash';

export function graphqlLodash(graphQLParams) {
  const pathToArgs = [];
  const queryAST = parse(graphQLParams.query);
  traverseOperation(queryAST, graphQLParams.operationName, {
    [Kind.DIRECTIVE]: {
      leave(node, _0, _1, _2, _3, resultPath) {
        var args = getLodashDirectiveArgs(node);

        // TODO: detect duplicates
        if (args !== null)
          _.set(pathToArgs, [...resultPath, '@_'], args);
      },
    },
  });

  return {
    query: print(stripQuery(queryAST)),
    transform: result => applyLodashDirective(pathToArgs, result)
  };
}

function getLodashDirectiveArgs(node) {
  if (node.name.value !== lodashDirective.name)
    return null;

  const args = getArgumentValues(lodashDirective, node);
  //Restore order of arguments
  const argsNames = node.arguments.map(node => node.name.value);
  const orderedArgs = {};
  for (const name of argsNames)
    orderedArgs[name] = args[name];
  return orderedArgs;
}

function applyLodashDirective(pathToArgs, result) {
  const data = result.data;
  if (data === null)
    return null;

  const changedData = applyOnPath(data, pathToArgs, (object, lodashArgs) => {
    for (const op in lodashArgs) {
      const arg = lodashArgs[op];
      switch (op) {
        case 'get':
          object = _.get(object, arg);
          break;
        case 'keyBy':
          object = (_ as any).keyBy(object, arg);
          break;
        case 'mapValues':
          object = _.mapValues(object, arg);
          break;
        case 'map':
          object = _.map(object, arg);
      }
    }
    return object;
  });

  return {...result, data: changedData};
}

function applyOnPath(result, pathToArgs, cb) {
  return traverse(result, pathToArgs);

  function traverse(root, pathRoot) {
    if (Array.isArray(root))
      return root.map(item => traverse(item, pathRoot));

    const changedObject = Object.assign(root);
    for (const key in pathRoot) {
      if (key === '@_')
        continue;

      let changedValue = traverse(root[key], pathRoot[key]);
      const lodashArgs = pathRoot[key]['@_'];
      if (lodashArgs)
        changedValue = cb(changedValue, lodashArgs);
      changedObject[key] = changedValue;
    }
    return changedObject;
  }
}

function stripQuery(queryAST) {
  return visit(queryAST, {
    [Kind.DIRECTIVE]: (node) => {
      if (node.name.value === '_')
        return null;
    },
  });
}

const lodashIDL = `
directive @_(
  get: String
  map: String
  keyBy: String
  mapValues: String
  join: String = ","
) on FIELD
`;

export const lodashDirectiveAST = parse(new Source(lodashIDL, 'lodashIDL'));
const lodashDirective = getDirectivesFromAST(lodashDirectiveAST)[0];

function getDirectivesFromAST(ast) {
  const dummyIDL = `
    type Query {
      dummy: String
    }
  `;
  const fullAST = concatAST([ast, parse(dummyIDL)]);
  const schema = buildASTSchema(fullAST);
  return schema.getDirectives();
}

function traverseOperation(queryAST, operationName, visitor) {
  const fragments = {};
  const operationAST = getOperationAST(queryAST, operationName);
  if (!operationAST) {
    throw new GraphQLError(
      'Must provide operation name if query contains multiple operations.'
    );
  }

  queryAST.definitions.forEach(definition => {
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments[definition.name.value] = definition;
  });

  const resultPath = [];
  traverse(operationAST);

  // TODO: account for field aliases
  function traverse(root) {
    visit(root, {
      enter(...args) {
        const node = args[0];

        if (node.kind === Kind.FIELD)
          resultPath.push((node.alias || node.name).value);

        const fn = getVisitFn(visitor, node.kind, /* isLeaving */ false);
        if (fn) {
          const result = fn.apply(visitor, [...args, resultPath.slice()]);
          if (result !== undefined)
            throw new GraphQLError('Can not change operation during traverse.');
        }
      },
      leave(...args) {
        const node = args[0];

        if (node.kind === Kind.FIELD)
          resultPath.pop();

        const fn = getVisitFn(visitor, node.kind, /* isLeaving */ true);
        if (fn) {
          const result = fn.apply(visitor, [...args, resultPath.slice()]);
          if (result !== undefined)
            throw new GraphQLError('Can not change operation during traverse.');
        }
      }
    });
  }
}

/**
 * Given a visitor instance, if it is leaving or not, and a node kind, return
 * the function the visitor runtime should call.
 */
function getVisitFn(visitor, kind, isLeaving) {
  const kindVisitor = visitor[kind];
  if (kindVisitor) {
    if (!isLeaving && typeof kindVisitor === 'function') {
      // { Kind() {} }
      return kindVisitor;
    }
    const kindSpecificVisitor =
      isLeaving ? kindVisitor.leave : kindVisitor.enter;
    if (typeof kindSpecificVisitor === 'function') {
      // { Kind: { enter() {}, leave() {} } }
      return kindSpecificVisitor;
    }
  } else {
    const specificVisitor = isLeaving ? visitor.leave : visitor.enter;
    if (specificVisitor) {
      if (typeof specificVisitor === 'function') {
        // { enter() {}, leave() {} }
        return specificVisitor;
      }
      const specificKindVisitor = specificVisitor[kind];
      if (typeof specificKindVisitor === 'function') {
        // { enter: { Kind() {} }, leave: { Kind() {} } }
        return specificKindVisitor;
      }
    }
  }
}
