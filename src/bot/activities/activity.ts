export type CraftItemActivity = Readonly<{
  itemCode: string;
  quantity: number;
  type: 'craftItem';
}>;

export type EquipItemActivity = Readonly<{
  itemCode: string;
  type: 'equipItem';
}>;

export type FarmResourceActivity = Readonly<{
  resourceCode: string;
  type: 'farmResource';
}>;

export type HuntMonsterActivity = Readonly<{
  monsterCode: string;
  type: 'huntMonster';
}>;

export type WithdrawItemActivity = Readonly<{
  itemCode: string;
  quantity: number;
  type: 'withdrawItem';
}>;

export type Activity =
  | CraftItemActivity
  | EquipItemActivity
  | FarmResourceActivity
  | HuntMonsterActivity
  | WithdrawItemActivity;
