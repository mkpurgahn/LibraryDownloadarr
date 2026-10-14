import * as css from 'css-tree';

const properties = new Set([
  'color', 'background-color', 'background-image', 'background-position', 'background-repeat', 'background-size',
  'font-family', 'font-style', 'font-weight', 'font-variant', 'line-height',
  'text-align', 'text-indent', 'text-decoration', 'text-transform', 'letter-spacing', 'word-spacing',
  'white-space', 'word-break', 'overflow-wrap', 'vertical-align',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-width', 'border-style', 'border-color', 'border-radius', 'border-collapse', 'border-spacing',
  'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height', 'box-sizing',
  'list-style-type', 'list-style-position', 'display', 'float', 'clear', 'src',
]);
const functions = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'min', 'max', 'clamp', 'format', 'linear-gradient', 'radial-gradient']);
export async function safeCss(value: string, resolve: (value: string) => Promise<string>, inline = false): Promise<string> {
  if (value.length > 512 * 1024) return '';
  let tree: css.CssNode;
  try { tree = css.parse(value, { context: inline ? 'declarationList' : 'stylesheet', positions: false }); }
  catch { return ''; }
  css.walk(tree, {
    enter(node: css.CssNode, item: css.ListItem<css.CssNode>, list: css.List<css.CssNode>) {
      const drop = () => { if (item && list) list.remove(item); return css.walk.skip; };
      if (node.type === 'Raw') return drop();
      if (node.type === 'Atrule' && (node.name.toLowerCase() !== 'font-face' || !node.block)) return drop();
      if (node.type === 'Rule' && /:|@|\\/.test(css.generate(node.prelude))) return drop();
      if (node.type === 'Declaration') {
        if (!properties.has(node.property.toLowerCase())) return drop();
        let unsafe = false;
        css.walk(node.value, child => {
          if (child.type === 'Raw' || (child.type === 'Function' && !functions.has(child.name.toLowerCase()))) unsafe = true;
        });
        if (unsafe) return drop();
        node.important = false;
      }
    },
  });
  const urls: css.Url[] = [];
  css.walk(tree, node => { if (node.type === 'Url') urls.push(node); });
  for (const node of urls) node.value = await resolve(node.value);
  return css.generate(tree);
}
