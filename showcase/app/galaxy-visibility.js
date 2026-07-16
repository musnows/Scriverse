/**
 * 银河图名称只由用户的显示开关控制，选中与关联状态不应绕过该开关。
 *
 * @param {boolean} labelsVisible
 * @returns {boolean}
 */
export function shouldRenderGalaxyLabel(labelsVisible) {
  return labelsVisible;
}
