// @meowerse/ui/cat3d — kept out of the root barrel so apps that don't show the cat never emit its
// poster and mesh (SP1 deferral). React-free pages import "@meowerse/ui/cat3d/attach" instead.
export { Cat3D } from "./Cat3D";
export { attachCat3D, attachAllCat3D } from "./attach";
