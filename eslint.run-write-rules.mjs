// A run's row changes only through RunRepository.change, which lives in server/src/history/. Code elsewhere does not
// reach the RunEntity table by another path: no repository of it, no query on it, no saveRun.
const MESSAGE = "Write a run's row through RunRepository.change in server/src/history/.";
const TOKEN_CALLS = new Set(['InjectRepository', 'getRepositoryToken']);
const WRITE_CALLS = new Set(['getRepository', 'update', 'insert', 'into', 'save', 'delete', 'increment', 'upsert']);

function isRunEntity(node) {
  return node !== undefined && node.type === 'Identifier' && node.name === 'RunEntity';
}

const noRunWrite = {
  meta: {
    type: 'problem',
    schema: [],
    docs: { description: "Forbid writing a run's row outside server/src/history/." },
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type === 'Identifier' && TOKEN_CALLS.has(callee.name) && isRunEntity(node.arguments[0])) {
          context.report({ node, message: MESSAGE });
          return;
        }
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') {
          return;
        }
        const name = callee.property.name;
        if (name === 'saveRun' || (WRITE_CALLS.has(name) && isRunEntity(node.arguments[0]))) {
          context.report({ node: callee.property, message: MESSAGE });
        }
      },
    };
  },
};

export const runWritePlugin = { rules: { 'no-run-write': noRunWrite } };
