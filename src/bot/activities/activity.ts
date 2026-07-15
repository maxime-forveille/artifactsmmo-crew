export type Activity =
  | {
      readonly itemCode: string;
      readonly quantity: number;
      readonly type: "craftItem";
    }
  | {
      readonly itemCode: string;
      readonly type: "equipItem";
    }
  | {
      readonly resourceCode: string;
      readonly type: "farmResource";
    }
  | {
      readonly monsterCode: string;
      readonly type: "huntMonster";
    };
