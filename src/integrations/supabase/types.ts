export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '14.18';
  };
  public: {
    Tables: {
      assets_status: {
        Row: {
          current_price: number | null;
          change_24h: number | null;
          radar_explanation: string | null;
          radar_signal: string | null;
          reward_pct: number | null;
          risk_pct: number | null;
          rsi_14: number | null;
          sma_50: number | null;
          sma_200: number | null;
          stable_explanation: string | null;
          stable_signal: string | null;
          ticker: string;
          updated_at: string;
          volume_spike: number | null;
        };
        Insert: {
          current_price?: number | null;
          change_24h?: number | null;
          radar_explanation?: string | null;
          radar_signal?: string | null;
          reward_pct?: number | null;
          risk_pct?: number | null;
          rsi_14?: number | null;
          sma_50?: number | null;
          sma_200?: number | null;
          stable_explanation?: string | null;
          stable_signal?: string | null;
          ticker: string;
          updated_at?: string;
          volume_spike?: number | null;
        };
        Update: {
          current_price?: number | null;
          change_24h?: number | null;
          radar_explanation?: string | null;
          radar_signal?: string | null;
          reward_pct?: number | null;
          risk_pct?: number | null;
          rsi_14?: number | null;
          sma_50?: number | null;
          sma_200?: number | null;
          stable_explanation?: string | null;
          stable_signal?: string | null;
          ticker?: string;
          updated_at?: string;
          volume_spike?: number | null;
        };
        Relationships: [];
      };
      shared_portfolios: {
        Row: {
          created_at: string;
          id: string;
          snapshot: Json;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          snapshot: Json;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          snapshot?: Json;
          user_id?: string;
        };
        Relationships: [];
      };
      // M1-T1 (F-3.1b): typed tables so `db.ts` / `priceAlerts.ts` queries are
      // strictly typed instead of relying on manual row casts. Mirrors the
      // idempotent baseline migration `0002_reconcile_schema_baseline.sql`.
      user_alerts: {
        Row: {
          condition: string;
          created_at: string;
          id: string;
          is_active: boolean;
          target_price: number;
          ticker: string;
          user_id: string;
        };
        Insert: {
          condition: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          target_price: number;
          ticker: string;
          user_id: string;
        };
        Update: {
          condition?: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          target_price?: number;
          ticker?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_portfolios: {
        Row: {
          created_at: string;
          id: string;
          positions: Json;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          positions?: Json;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          positions?: Json;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      get_shared_portfolio: {
        Args: { share_id: string };
        Returns: {
          created_at: string;
          id: string;
          snapshot: Json;
        }[];
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
