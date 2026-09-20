module Gtd.Command.Brainstorm exposing (Command(..), encode)

{-| Commands the Brainstorm workflow alone is allowed to send.
-}

import Gtd.Command as Base
import Gtd.Id exposing (ActionId, ProjectId)
import Json.Encode as Encode


type Command
    = LoadBrainstormOutcome ProjectId
    | SaveBrainstorm ActionId String (Maybe String)
    | SaveStandaloneBrainstorm String String
    | ShuffleBrainstormWords
    | FocusBrainstormIdeas Int Int
    | ShowProject ProjectId


encode : Command -> Encode.Value
encode command =
    Base.encode
        (case command of
            LoadBrainstormOutcome projectId ->
                Base.LoadBrainstormOutcome projectId

            SaveBrainstorm actionId ideas outcome ->
                Base.SaveBrainstorm actionId ideas outcome

            SaveStandaloneBrainstorm topic ideas ->
                Base.SaveStandaloneBrainstorm topic ideas

            ShuffleBrainstormWords ->
                Base.ShuffleBrainstormWords

            FocusBrainstormIdeas start end ->
                Base.FocusBrainstormIdeas start end

            ShowProject projectId ->
                Base.ShowProject projectId
        )
