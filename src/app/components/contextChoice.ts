import { create } from "zustand";

interface ChoiceState {
    choice: number | undefined,
    setChoice: (choice: number) => void,
    email: string | undefined,
    setEmail: (email: string) => void,
    secret: string | undefined,
    setSecret: (secret: string) => void,
    userAuthorized: boolean,
    setUserAuthorized: (userAuthorized: boolean) => void,

}

export const useStoreChoice = create<ChoiceState>()(set => ({
    choice: undefined,
    setChoice: (choice: number) => { set(() => ({ choice })) },
    email: undefined,
    setEmail: (email: string) => { set(() => ({ email })) },
    secret: undefined,
    setSecret: (secret: string) => { set(() => ({ secret })) },
    userAuthorized: false,
    setUserAuthorized: (userAuthorized: boolean) => { set(() => ({ userAuthorized })) },
}));
